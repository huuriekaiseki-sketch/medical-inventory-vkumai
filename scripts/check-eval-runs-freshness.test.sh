#!/bin/bash
# WHY: issue #496向けの機械トリガー(scripts/check-eval-runs-freshness.sh)の回帰テスト。
# 一時gitリポジトリでworkflows変更のみのコミット・eval-runs.jsonl同時更新のコミットを作り、
# 期待通りに警告が出る/出ないことを確認する。check-agent-baseline-freshness.test.shと同型。
#
# 実行: bash scripts/check-eval-runs-freshness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-eval-runs-freshness.sh"

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
    echo "  NG: $label (見つかってはいけない文字列が見つかった)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

TMP_REPO="$(mktemp -d)"
cd "$TMP_REPO"
git init --quiet
git config user.email "test@example.com"
git config user.name "test"

mkdir -p .claude/workflows docs/agents
cat > .claude/workflows/aidd-phase2.js <<'EOF'
export const meta = { name: "aidd-phase2" }
EOF
echo "[]" > docs/agents/eval-runs.jsonl
git add .
git commit --quiet -m "base"

run_script() {
  # $1: base, $2: head。exit code を EXIT_CODE に、出力を OUT に入れる
  set +e
  OUT="$(bash "$SCRIPT" "$1" "$2" 2>&1)"
  EXIT_CODE=$?
  set -e
}
assert_exit() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected exit $expected, actual $actual)"
    fail=1
  fi
}

echo "=== scenario 1: workflowsのみ変更 → error + exit 1（2026-09-05 に warning から変更） ==="
# WHY: ::warning:: は run を開かないと見えず、3 件の PR で無視されたまま eval-runs.jsonl が止まっていた
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// prompt change
EOF
git add .
git commit --quiet -m "change workflow prompt"
run_script HEAD~1 HEAD
assert_contains "$OUT" "::error::" "error が出る"
assert_contains "$OUT" "eval-skip" "逃げ道（eval-skip）の案内が含まれる"
assert_exit "$EXIT_CODE" "1" "exit 1 で失敗する"

echo "=== scenario 1b: PR本文に eval-skip: <理由> があれば notice + exit 0 ==="
set +e
OUT="$(PR_BODY=$'## 30秒サマリー\n- 変更概要: 定数のみ\n\neval-skip: DEFAULT_TOKEN_CAP の数値変更のみでプロンプト文言は不変\n' bash "$SCRIPT" HEAD~1 HEAD 2>&1)"
EXIT_CODE=$?
set -e
assert_contains "$OUT" "::notice::" "notice が出る"
assert_contains "$OUT" "DEFAULT_TOKEN_CAP の数値変更のみ" "理由が出力に含まれる"
assert_not_contains "$OUT" "::error::" "error は出ない"
assert_exit "$EXIT_CODE" "0" "exit 0 で通る"

echo "=== scenario 1c: eval-skip: の理由が空 → error + exit 1 ==="
set +e
OUT="$(PR_BODY=$'eval-skip:\n' bash "$SCRIPT" HEAD~1 HEAD 2>&1)"
EXIT_CODE=$?
set -e
assert_contains "$OUT" "理由が空" "理由が空である旨の error が出る"
assert_exit "$EXIT_CODE" "1" "exit 1 で失敗する"

echo "=== scenario 1d: eval-skip が行頭以外（本文中の言及） → 申告とみなさず error ==="
set +e
OUT="$(PR_BODY=$'次回は eval-skip: を使う予定\n' bash "$SCRIPT" HEAD~1 HEAD 2>&1)"
EXIT_CODE=$?
set -e
assert_exit "$EXIT_CODE" "1" "行頭でなければ申告扱いにしない"

echo "=== scenario 2: workflows変更 + 「その木で測った」記録を同時コミット → OK + exit 0 ==="
# WHY(2026-09-10・R11 の後段): 以前はここで **workflowsTree を持たない古い形式**の 1 行を
#      足しても通っていた。いまは「いま変更したプロンプトの木で測ったか」まで見るので、
#      その回の workflowsTree が要る。**先に木を求めてから記録を書く**（実際の eval と同じ順序）
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// another change
EOF
git add .claude/workflows/aidd-phase2.js
git commit --quiet -m "change workflow prompt"
NEW_TREE="$(git rev-parse "HEAD:.claude/workflows")"
printf '{"timestamp":"2026-09-10T00:00:00Z","script":"eval-workflow-prompts","fixtureSet":"db-impl","pass":4,"total":4,"workflowsTree":"%s"}\n' "$NEW_TREE" >> docs/agents/eval-runs.jsonl
git add docs/agents/eval-runs.jsonl
git commit --quiet -m "record eval run measured on that tree"
run_script HEAD~2 HEAD
assert_not_contains "$OUT" "::error::" "error が出ない（その木で測った記録がある）"
assert_contains "$OUT" "で測った eval の記録が 1 行" "何行がその木で測ったものかを出す"
assert_exit "$EXIT_CODE" "0" "exit 0"

echo "=== scenario 2b: 更新はあるが「別の木で測った古い記録」だけなら落とす（R11 の再現） ==="
# **ファイルに差分があるか**しか見ていなかった頃は、この形が通っていた
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// third change
EOF
echo '{"timestamp":"2026-07-23T00:00:00Z","script":"eval-workflow-prompts","fixtureSet":"db-impl","pass":4,"total":4}' >> docs/agents/eval-runs.jsonl
git add .
git commit --quiet -m "change prompt + append an old record"
run_script HEAD~1 HEAD
assert_contains "$OUT" "::error::" "古い記録の追記では通さない"
assert_contains "$OUT" "測った記録が 1 行もありません" "更新はあるが古い、と言い分ける"
assert_exit "$EXIT_CODE" "1" "exit 1"

echo "=== scenario 2c: 未コミットのまま測った回（workflowsDirty）は証拠に数えない ==="
# その回は clone(HEAD) から読むので、**手元のプロンプトの変更が評価に入っていない**
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// fourth change
EOF
git add .claude/workflows/aidd-phase2.js
git commit --quiet -m "change workflow prompt again"
DIRTY_TREE="$(git rev-parse "HEAD:.claude/workflows")"
printf '{"timestamp":"2026-09-10T01:00:00Z","script":"eval-sweep-recall","fixtureSet":"sweep-db","pass":2,"total":2,"workflowsTree":"%s","workflowsDirty":true}\n' "$DIRTY_TREE" >> docs/agents/eval-runs.jsonl
git add docs/agents/eval-runs.jsonl
git commit --quiet -m "record a dirty run"
run_script HEAD~2 HEAD
assert_contains "$OUT" "::error::" "木が一致しても workflowsDirty なら証拠に数えない"
assert_exit "$EXIT_CODE" "1" "exit 1"

echo "=== scenario 2d: 古い記録だけでも eval-skip の逃げ道は残る ==="
set +e
OUT="$(PR_BODY=$'eval-skip: 定数のみの変更で文言は不変\n' bash "$SCRIPT" HEAD~2 HEAD 2>&1)"
EXIT_CODE=$?
set -e
assert_contains "$OUT" "::notice::" "理由つきの申告なら通る"
assert_exit "$EXIT_CODE" "0" "exit 0"

echo "=== scenario 3: workflowsに無関係な変更のみ → 何も出ない + exit 0 ==="
echo "# unrelated" >> README.md
git add .
git commit --quiet -m "unrelated doc change"
run_script HEAD~1 HEAD
assert_not_contains "$OUT" "::error::" "error が出ない（workflows変更なし）"
assert_exit "$EXIT_CODE" "0" "exit 0"

echo "=== scenario 4: .claude/workflows/lib/配下(プロンプト正本の切り出し先)の変更も対象になる ==="
mkdir -p .claude/workflows/lib/prompts
echo "export const x = 1" > .claude/workflows/lib/prompts/db-impl.js
git add .
git commit --quiet -m "change prompt source of truth in lib/"
run_script HEAD~1 HEAD
assert_contains "$OUT" "::error::" "error が出る（lib/prompts/配下もプロンプト正本のため検知対象）"
assert_exit "$EXIT_CODE" "1" "exit 1"

cd - > /dev/null
rm -rf "$TMP_REPO"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
