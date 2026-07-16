#!/bin/bash
# WHY: scripts/check-otel-collector-status.sh(SessionStart hook)の回帰テスト。
# scenario 3は実物のscripts/otel-debug-collector.mjsをテスト用ポートで起動して使う
# （生TCP接続のみ返す代用サーバ(nc等)はHTTPレスポンスを返さずcurlが空応答エラーに
# なるため、「未起動」と誤判定される。実物同様にHTTPレスポンスを返すサーバでないと
# 正しく検証できない。issue #430）。
#
# 実行: bash scripts/check-otel-collector-status.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-otel-collector-status.sh"

fail=0
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
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

echo "=== scenario 1: CLAUDE_CODE_ENABLE_TELEMETRYが未設定 → 何も出力しない ==="
OUT="$(env -u CLAUDE_CODE_ENABLE_TELEMETRY bash "$SCRIPT" < /dev/null)"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: テレメトリ有効だが誰も listen していないポート → 警告する ==="
OUT="$(CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:19191" bash "$SCRIPT" < /dev/null)"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "起動し忘れている可能性" "起動忘れの警告文言が含まれる"

echo "=== scenario 3: テレメトリ有効かつ実物のcollectorが応答する → 何も出力しない ==="
COLLECTOR_LOG_DIR="$(mktemp -d)"
OTEL_DEBUG_COLLECTOR_PORT=19192 OTEL_DEBUG_COLLECTOR_LOG_DIR="$COLLECTOR_LOG_DIR" \
  node "$SCRIPT_DIR/otel-debug-collector.mjs" > /dev/null 2>&1 &
COLLECTOR_PID=$!
trap 'kill "$COLLECTOR_PID" 2>/dev/null || true; rm -rf "$COLLECTOR_LOG_DIR"' EXIT
sleep 0.5
OUT="$(CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_EXPORTER_OTLP_ENDPOINT="http://localhost:19192" bash "$SCRIPT" < /dev/null)"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
