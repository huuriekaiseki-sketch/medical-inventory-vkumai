#!/bin/bash
# WHY: scripts/check-domain-decisions-suggest.sh(Stop hook)の回帰テスト。
# 実物のgitに依存させず、テスト用のフェイクgitをPATHの先頭に注入して決定的に検証する。
#
# このhookはissue #685で type:"agent" から type:"command" へ置き換えたもの。
# agent版は「発火しない」場面でも毎ターンサブエージェントを起動し、判定理由を返し続けて
# いた。置き換えの要点は次の3つで、本テストはそれぞれに対応する:
#   1. 高リスクパスに触れていなければ沈黙する（毎ターンの空振りを無くす）
#   2. 触れていれば1回だけ通知する
#   3. 同一セッション内の2回目以降は沈黙する（重複抑止をマーカーファイルで決定的に行う）
#
# 実行: bash scripts/check-domain-decisions-suggest.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/check-domain-decisions-suggest.sh"

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
assert_silent() {
  local actual="$1" label="$2"
  # 沈黙は無出力であること（issue #737。公式仕様では表示しないなら systemMessage を省略する。
  # 以前は空文字の systemMessage を出力契約としていた）
  if [ -z "$(printf '%s' "$actual" | tr -d '[:space:]')" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}

FAKE_BIN="$(mktemp -d)"
STATE_DIR="$REPO_ROOT/.claude/.domain-decisions-suggest-state"
# WHY: 実行前に既存のマーカーが残っていると、通知されるべきケースが沈黙して誤判定になる。
#      テスト用sessionのマーカーのみを対象に、前後で掃除する
clean_markers() {
  rm -f "$STATE_DIR"/hooktest-*.done
}
cleanup() {
  rm -rf "$FAKE_BIN"
  clean_markers
}
trap cleanup EXIT
# 前回の失敗で残ったマーカーがあると、通知されるべきケースが沈黙して誤判定になる
clean_markers

setup_fake_git() {
  # $1 に git diff --name-only HEAD の出力を渡す（git status --porcelain は空にする）
  local changed="$1"
  cat > "$FAKE_BIN/git" <<EOF
#!/bin/bash
if [ "\$1" = "diff" ]; then
  printf '%s' "$changed"
  if [ -n "$changed" ]; then echo; fi
  exit 0
fi
exit 0
EOF
  chmod +x "$FAKE_BIN/git"
}

run_hook() {
  local session_id="$1"
  printf '{"session_id":"%s","transcript_path":""}' "$session_id" \
    | PATH="$FAKE_BIN:$PATH" bash "$SCRIPT"
}

echo "== 1. 変更ファイルが無ければ沈黙する =="
setup_fake_git ""
assert_silent "$(run_hook hooktest-empty)" "変更なし → 沈黙"

echo "== 2. 高リスクパス以外だけなら沈黙する（毎ターンの空振りを無くす） =="
setup_fake_git "README.md"
assert_silent "$(run_hook hooktest-lowrisk)" "README.mdのみ → 沈黙"

echo "== 3. supabase/migrations/ に触れたら通知する =="
setup_fake_git "supabase/migrations/20260101000000_x.sql"
out="$(run_hook hooktest-migration)"
assert_contains "$out" "高リスクドメイン" "migration変更 → 通知"
assert_contains "$out" "supabase/migrations/20260101000000_x.sql" "通知に対象ファイル名が含まれる"
assert_contains "$out" "docs/agents/decisions.md" "通知に追記先が含まれる"

echo "== 4. 同一セッションの2回目は沈黙する（重複抑止） =="
assert_silent "$(run_hook hooktest-migration)" "同じsession_idの再実行 → 沈黙"

echo "== 5. セッションが変われば再び通知する =="
out2="$(run_hook hooktest-migration-2)"
assert_contains "$out2" "高リスクドメイン" "別session_id → 通知"

echo "== 6. src/lib/supabase/ と middleware.ts も対象 =="
setup_fake_git "src/lib/supabase/server.ts"
assert_contains "$(run_hook hooktest-libsupabase)" "高リスクドメイン" "src/lib/supabase/ → 通知"
setup_fake_git "middleware.ts"
assert_contains "$(run_hook hooktest-middleware)" "高リスクドメイン" "middleware.ts → 通知"
setup_fake_git "src/proxy.ts"
assert_contains "$(run_hook hooktest-proxy)" "高リスクドメイン" "proxy.ts → 通知（issue #681。Next.js 16でmiddleware.tsから改名）"

echo "== 7. ファイル名にドメイン語を含む場合も対象 =="
setup_fake_git "src/lib/facilities/repository.ts"
assert_contains "$(run_hook hooktest-domainword)" "高リスクドメイン" "facility を含むパス → 通知"

echo "== 8. aidd.config.json が無ければ汎用既定値だけで判定する（issue #420 v1 セット B2） =="
NO_CFG="$FAKE_BIN/none.json"
setup_fake_git "src/lib/facilities/repository.ts"
assert_silent "$(AIDD_CONFIG_FILE="$NO_CFG" run_hook hooktest-nocfg-facility)" "設定無しでは facility（固有語）は対象外"
setup_fake_git "src/lib/auth/session.ts"
out8="$(AIDD_CONFIG_FILE="$NO_CFG" run_hook hooktest-nocfg-auth)"
assert_contains "$out8" "高リスクドメイン" "設定無しでも auth（汎用既定）は通知"
assert_contains "$out8" "docs/agents/decisions.md" "追記先も既定値"

echo "== 9. 導入先の設定で語彙と追記先を差し替えられる =="
printf '{"risk":{"domainKeywords":["corpus"]},"docs":{"domain":"docs/glossary.md","decisions":"docs/adr/README.md"}}\n' > "$FAKE_BIN/custom.json"
setup_fake_git "src/corpus/loader.ts"
out9="$(AIDD_CONFIG_FILE="$FAKE_BIN/custom.json" run_hook hooktest-custom)"
assert_contains "$out9" "corpus" "設定の domainKeywords で通知"
assert_contains "$out9" "docs/adr/README.md" "追記先が設定の値になる"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "PASSED"
