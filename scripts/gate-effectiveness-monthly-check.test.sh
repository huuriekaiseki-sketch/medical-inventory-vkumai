#!/bin/bash
# WHY: scripts/gate-effectiveness-monthly-check.sh(Stop hook)の回帰テスト。
# 実物のlogs/.claude/.gate-effectiveness-stateに依存させず、サンドボックスディレクトリに
# scripts/一式をコピーして決定的に検証する（issue #412）。
#
# 実行: bash scripts/gate-effectiveness-monthly-check.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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
assert_empty_system_message() {
  local actual="$1" label="$2"
  local msg
  msg="$(printf '%s' "$actual" | jq -r '.systemMessage')"
  if [ -z "$msg" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (systemMessage=$msg)"
    fail=1
  fi
}
assert_file_exists() {
  local path="$1" label="$2"
  if [ -f "$path" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (not found: $path)"
    fail=1
  fi
}

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/scripts/lib" "$SANDBOX/logs" "$SANDBOX/.claude"
cp "$SCRIPT_DIR/gate-effectiveness-monthly-check.sh" "$SANDBOX/scripts/"
cp "$SCRIPT_DIR/summarize-loop-observability.sh" "$SANDBOX/scripts/"
cp "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$SANDBOX/scripts/lib/"

STATE_FILE="$SANDBOX/.claude/.gate-effectiveness-state/last-summary-at"
LOG_FILE="$SANDBOX/logs/loop-observability.jsonl"

run_hook() {
  set +e
  OUT="$(cd "$SANDBOX" && bash scripts/gate-effectiveness-monthly-check.sh < /dev/null)"
  EXIT_CODE=$?
  set -e
}

write_sample_log() {
  cat > "$LOG_FILE" <<'EOF'
{"timestamp":"2026-07-01T00:00:00Z","loop":"developer","agent":"reviewer","feature":"orders-list","attempt":1,"model":"sonnet","tokens":1000,"costUsd":0.1,"intent":"check","scenario":"quality","result":"pass","reason":"ok"}
{"timestamp":"2026-07-02T00:00:00Z","loop":"developer","agent":"implementer","feature":"orders-list","attempt":1,"model":"sonnet","tokens":2000,"costUsd":0.2,"intent":"tdd","scenario":"red-green","result":"fail","reason":"test failed"}
EOF
}

echo "=== scenario 1: logs/loop-observability.jsonlが無い → 何も出力せず状態ファイルも作らない ==="
run_hook
assert_empty_system_message "$OUT" "systemMessageが空である"
if [ -f "$STATE_FILE" ]; then
  echo "  NG: 状態ファイルが作られていないこと (unexpectedly found: $STATE_FILE)"
  fail=1
else
  echo "  OK: 状態ファイルが作られていないこと"
fi

echo "=== scenario 2: ログはあるが状態ファイルが無い(初回) → サマリを出力し状態ファイルを作る ==="
write_sample_log
run_hook
assert_contains "$OUT" "品質ゲート月次サマリ" "systemMessageにサマリ見出しが含まれる"
assert_contains "$OUT" "reviewer" "systemMessageにagent別内訳が含まれる"
assert_file_exists "$STATE_FILE" "状態ファイルが作られている"

echo "=== scenario 3: 状態ファイルが新しい(直前に更新) → 何も出力しない ==="
run_hook
assert_empty_system_message "$OUT" "systemMessageが空である(間引かれる)"

echo "=== scenario 4: 状態ファイルが31日以上前 → 再度サマリを出力する ==="
touch -t "$(date -v-31d +%Y%m%d%H%M 2>/dev/null || date -d '31 days ago' +%Y%m%d%H%M)" "$STATE_FILE"
run_hook
assert_contains "$OUT" "品質ゲート月次サマリ" "31日経過後は再びsystemMessageが出る"

echo "=== scenario 5: summarize-gate-blocked.shが無い環境でもクラッシュしない(fail-open) ==="
assert_contains "$OUT" "blocked状態" "summarize-gate-blocked.sh不在でもblocked状態の見出し自体は出る(取得失敗の断り書き付き)"
assert_contains "$OUT" "取得できませんでした" "取得失敗時の断り書きが出る"

echo "=== scenario 6: summarize-gate-blocked.shがある環境 → blocked集計が本文に含まれる ==="
rm -f "$STATE_FILE"
cp "$SCRIPT_DIR/summarize-gate-blocked.sh" "$SANDBOX/scripts/"
cp "$SCRIPT_DIR/lib/gate-effectiveness-summary.ts" "$SANDBOX/scripts/lib/"
cp "$SCRIPT_DIR/lib/canonical-event.ts" "$SANDBOX/scripts/lib/"
cp "$SCRIPT_DIR/lib/reconstruct-loop-observability.ts" "$SANDBOX/scripts/lib/"
# summarize-gate-blocked.shはデフォルトでこのリポジトリの本物のprojectDirを見に行くため
# (npxのモジュール解決のためnode_modulesはリポジトリルートのものをそのまま使う必要があり、
# ここでは"クラッシュせず実行でき、blocked集計の見出しが出る"ことのみを確認する
# (件数の具体値はCI環境依存のため固定しない)
run_hook
assert_contains "$OUT" "## blocked状態" "blocked集計セクションの見出しが出る(issue #569)"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
