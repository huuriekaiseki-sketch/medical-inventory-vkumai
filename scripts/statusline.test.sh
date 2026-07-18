#!/bin/bash
# WHY: statusline.shはClaude Code本体からstdin経由で呼ばれるためvitestの対象外。issue #446の
# ゲート条件（公式ドキュメントで確認したstdin JSONスキーマに沿って動くこと）を、公式ドキュメント
# 掲載のサンプルJSON・欠落パターンをそのままfixtureとして固定し回帰テストする。
#
# 実行: bash scripts/statusline.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="$SCRIPT_DIR/statusline.sh"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"
git init -q
git checkout -q -b test-branch

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual output: $haystack"
    fail=1
  fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  NG: $label (should NOT contain: $needle)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

echo "=== test: 公式ドキュメント掲載のフルサンプルJSON（rate_limits・context_window等すべて存在） ==="
FULL_JSON='{"model":{"id":"claude-opus-4-8","display_name":"Opus"},"cost":{"total_cost_usd":0.01234,"total_duration_ms":45000},"context_window":{"used_percentage":8,"remaining_percentage":92},"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":41.2}},"session_id":"abc123"}'
OUTPUT="$(echo "$FULL_JSON" | bash "$STATUSLINE")"
assert_contains "$OUTPUT" "[Opus]" "モデル表示名が表示される"
assert_contains "$OUTPUT" "branch:test-branch" "現在のgitブランチが表示される"
assert_contains "$OUTPUT" "ctx:8%" "context使用率が整数で表示される"
assert_contains "$OUTPUT" "cost:\$0.01" "セッションコストがUSDで表示される"
assert_contains "$OUTPUT" "5h:24%" "5時間レート制限使用率が四捨五入して表示される"
assert_contains "$OUTPUT" "7d:41%" "週次レート制限使用率が表示される"

echo "=== test: rate_limits不在（Claude.ai Pro/Max未契約、公式ドキュメント記載の欠落パターン） ==="
NO_RL_JSON='{"model":{"display_name":"Sonnet"},"cost":{"total_cost_usd":0},"context_window":{"used_percentage":null},"session_id":"def456"}'
OUTPUT="$(echo "$NO_RL_JSON" | bash "$STATUSLINE")"
assert_contains "$OUTPUT" "[Sonnet]" "モデル表示名が表示される"
assert_contains "$OUTPUT" "cost:\$0.00" "コスト0円も表示される"
assert_not_contains "$OUTPUT" "5h:" "rate_limits不在時は5h表示が出ない"
assert_not_contains "$OUTPUT" "7d:" "rate_limits不在時は7d表示が出ない"
assert_not_contains "$OUTPUT" "ctx:" "context_window.used_percentageがnullの場合ctx表示が出ない"

echo "=== test: five_hourのみ存在しseven_dayが不在（rate_limitsの各windowが独立して不在になりうる公式仕様） ==="
PARTIAL_RL_JSON='{"model":{"display_name":"Opus"},"cost":{"total_cost_usd":1.5},"rate_limits":{"five_hour":{"used_percentage":10}}}'
OUTPUT="$(echo "$PARTIAL_RL_JSON" | bash "$STATUSLINE")"
assert_contains "$OUTPUT" "5h:10%" "five_hourのみ表示される"
assert_not_contains "$OUTPUT" "7d:" "seven_day不在時は7d表示が出ない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
