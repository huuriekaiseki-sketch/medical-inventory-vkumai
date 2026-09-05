#!/bin/bash
# WHY: issue #635向けのStop hook(scripts/ai-check-suggest.sh)の回帰テスト。
# transcript全文に対するgrepではなく「実際に実行されたBashコマンド」のみを対象にすることで、
# 警告文自体・会話中の言及に対する自己抑制/誤判定が起きないことを確認する。
#
# 対象スクリプトは`cd "$(dirname "$0")/.."`で自身の場所からrepo rootへ移動するため、
# テストでは一時gitリポジトリ配下の`scripts/ai-check-suggest.sh`にコピーして実行する。
#
# 実行: bash scripts/ai-check-suggest.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/ai-check-suggest.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label"
    echo "      expected NOT to find: $needle"
    echo "      actual: $haystack"
    fail=1
  else
    echo "  OK: $label"
  fi
}

WORKDIR="$(mktemp -d)"
cleanup() { rm -rf "$WORKDIR"; }
trap cleanup EXIT

# 一時gitリポジトリを作り、scripts/ai-check-suggest.shをコピーして配置する。
setup_sandbox_repo() {
  local sandbox="$1"
  mkdir -p "$sandbox/scripts/lib"
  cp "$SCRIPT" "$sandbox/scripts/ai-check-suggest.sh"
  # 設定読み取りの共通関数も一緒に置く（無ければ fail-open で既定の npm 判定になる）
  cp "$SCRIPT_DIR/lib/aidd-config.sh" "$sandbox/scripts/lib/aidd-config.sh"
  (
    cd "$sandbox"
    git init -q
    git config user.email test@example.com
    git config user.name test
    echo "// initial" > dummy.ts
    git add dummy.ts
    git commit -q -m init
    echo "// modified" >> dummy.ts
  )
}

run_hook() {
  local sandbox="$1" session_id="$2" transcript_path="$3"
  local input
  input="$(jq -n --arg sid "$session_id" --arg tp "$transcript_path" '{session_id: $sid, transcript_path: $tp}')"
  (
    cd "$sandbox"
    printf '%s' "$input" | bash "scripts/ai-check-suggest.sh"
  )
}

echo "=== scenario 1: 過去の警告文のみがtranscriptにある場合 → 自己マッチせず警告が出る(issue #635の主題) ==="
SANDBOX1="$WORKDIR/sandbox1"
setup_sandbox_repo "$SANDBOX1"
TRANSCRIPT1="$WORKDIR/transcript_warning_only.jsonl"
cat > "$TRANSCRIPT1" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"警告: ソースコード変更（.ts/.tsx/.sql）があるにもかかわらず、このセッションで npm run ai:check 相当のコマンド（typecheck/lint/test）が実行された痕跡が見当たりません。実行を検討してください。"}]}}
EOF
OUT="$(run_hook "$SANDBOX1" "session-warning-only" "$TRANSCRIPT1")"
assert_contains "$OUT" "systemMessage" "systemMessageキーが存在する"
assert_not_contains "$OUT" '"systemMessage": ""' "空文字列ではない(警告が出ている＝自己抑制されない)"

echo "=== scenario 2: 会話中の言及のみ(実行なし) → 実行済み扱いにならず警告が出る ==="
SANDBOX2="$WORKDIR/sandbox2"
setup_sandbox_repo "$SANDBOX2"
TRANSCRIPT2="$WORKDIR/transcript_mention_only.jsonl"
cat > "$TRANSCRIPT2" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"次に npm run test を実行しましょう。"}]}}
EOF
OUT="$(run_hook "$SANDBOX2" "session-mention-only" "$TRANSCRIPT2")"
assert_not_contains "$OUT" '"systemMessage": ""' "空文字列ではない(言及のみでは実行済み扱いにならない)"

echo "=== scenario 3: 実際にBashでnpm run testが実行された → 実行済みと判定され警告は出ない ==="
SANDBOX3="$WORKDIR/sandbox3"
setup_sandbox_repo "$SANDBOX3"
TRANSCRIPT3="$WORKDIR/transcript_executed.jsonl"
cat > "$TRANSCRIPT3" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run test"}}]}}
EOF
OUT="$(run_hook "$SANDBOX3" "session-executed" "$TRANSCRIPT3")"
# WHY(issue #737): 報告事項なしは無出力（公式仕様では表示しないなら systemMessage を省略する）。以前は空文字を出していた
if [ -z "$OUT" ]; then echo "  OK: 無出力である(実行済みのため警告なし)"; else echo "  NG: 無出力でない(actual=$OUT)"; fail=1; fi

echo "=== scenario 4: 未実行のまま同一sessionで再Stop → 状態ハッシュが書かれていないため再度警告が出る(issue #635) ==="
SANDBOX4="$WORKDIR/sandbox4"
setup_sandbox_repo "$SANDBOX4"
TRANSCRIPT4="$WORKDIR/transcript_warning_only2.jsonl"
cat > "$TRANSCRIPT4" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"text","text":"警告: npm run ai:check相当が未実行です。"}]}}
EOF
OUT1="$(run_hook "$SANDBOX4" "session-repeat" "$TRANSCRIPT4")"
OUT2="$(run_hook "$SANDBOX4" "session-repeat" "$TRANSCRIPT4")"
assert_not_contains "$OUT1" '"systemMessage": ""' "1回目: 警告が出る"
assert_not_contains "$OUT2" '"systemMessage": ""' "2回目(未実行のまま再Stop): 依然として警告が出る(自己抑制されない)"

echo "=== scenario 5: 実行済み判定のコマンドは aidd.config.json の commands から作る（issue #420 v1 セット B2） ==="
SANDBOX5="$WORKDIR/sandbox5"
setup_sandbox_repo "$SANDBOX5"
printf '{"commands":{"check":"make check","test":"pytest"}}\n' > "$SANDBOX5/aidd.config.json"
TRANSCRIPT5A="$WORKDIR/transcript_pytest.jsonl"
cat > "$TRANSCRIPT5A" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"pytest -q"}}]}}
EOF
OUT="$(run_hook "$SANDBOX5" "session-cfg-a" "$TRANSCRIPT5A")"
if [ -z "$OUT" ]; then echo "  OK: 設定のコマンド（pytest）を実行済みと判定"; else echo "  NG: 設定のコマンドが効かない(actual=$OUT)"; fail=1; fi
TRANSCRIPT5B="$WORKDIR/transcript_npm_under_cfg.jsonl"
cat > "$TRANSCRIPT5B" <<'EOF'
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"npm run test"}}]}}
EOF
OUT="$(run_hook "$SANDBOX5" "session-cfg-b" "$TRANSCRIPT5B")"
assert_contains "$OUT" "make check" "設定があれば npm は実行済み扱いにならず、警告文は設定の check コマンドを指す"

echo "=== scenario 6: 設定が \"npm test\" でも \"npm run test\" を実行済み扱いにする（npm run X ≡ npm X） ==="
SANDBOX6="$WORKDIR/sandbox6"
setup_sandbox_repo "$SANDBOX6"
printf '{"commands":{"test":"npm test"}}\n' > "$SANDBOX6/aidd.config.json"
OUT="$(run_hook "$SANDBOX6" "session-npm-alias" "$TRANSCRIPT3")"
if [ -z "$OUT" ]; then echo "  OK: npm run test を npm test の別表記として実行済みと判定"; else echo "  NG: 別表記が効かない(actual=$OUT)"; fail=1; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
