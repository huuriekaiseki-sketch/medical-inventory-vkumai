#!/bin/bash
# WHY: subagent-statusline.shはClaude Code本体からstdin経由で呼ばれるためvitestの対象外
# （statusline.test.shと同じ理由）。fixtureは2026-07-18に実機（scripts/
# subagent-statusline-debug-collector.shで捕捉した実際のtasks配列JSON）で確認した構造を
# 元にしている。公式ドキュメントのみを根拠にした憶測フィールドは含まない。
#
# 実行: bash scripts/subagent-statusline.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUBAGENT_STATUSLINE="$SCRIPT_DIR/subagent-statusline.sh"

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
assert_equal() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected: $expected"
    echo "      actual:   $actual"
    fail=1
  fi
}

echo "=== test: 実機捕捉した複数taskペイロード（2026-07-18、columns:37の狭い実測値） ==="
REAL_JSON='{"session_id":"5f156845-402e-4078-9e08-ce7129859f93","cwd":"/repo","prompt_id":"79b6c8d3","columns":37,"tasks":[{"id":"a9b77940bac699b4f","type":"local_agent","status":"running","description":"Grep TODO occurrences","label":"Grep TODO occurrences","startTime":1784374971089,"model":"claude-sonnet-5","contextWindowSize":1000000,"tokenCount":21668,"tokenSamples":[0,0,0,21668],"cwd":"/repo"},{"id":"a6dd56ba2c7ff457b","type":"local_agent","status":"running","description":"Grep FIXME occurrences","label":"Grep FIXME occurrences","startTime":1784374972500,"model":"claude-sonnet-5","contextWindowSize":1000000,"tokenCount":21089,"tokenSamples":[0,0,21089],"cwd":"/repo"}]}'
OUTPUT="$(echo "$REAL_JSON" | bash "$SUBAGENT_STATUSLINE")"
LINE_COUNT="$(echo "$OUTPUT" | wc -l | tr -d ' ')"
assert_equal "$LINE_COUNT" "2" "task数ぶんの行数が出力される"
assert_contains "$OUTPUT" '"id":"a9b77940bac699b4f"' "1件目のidがそのまま反映される"
assert_contains "$OUTPUT" "Grep TODO occurrences" "labelが表示される"
assert_contains "$OUTPUT" "21.7ktok" "tokenCountが1000以上のときk単位で小数第1位まで表示される"
assert_contains "$OUTPUT" "2.2%" "tokenCount/contextWindowSizeから算出したcontext使用率が表示される"
TRUNC_OK=1
echo "$OUTPUT" | while IFS= read -r line; do
  LEN=$(echo "$line" | jq -r '.content | length')
  if [ "$LEN" -gt 37 ]; then
    echo "  NG: content が columns(37) を超えている: ${LEN}コードポイント ($line)"
    exit 1
  fi
done || TRUNC_OK=0
if [ "$TRUNC_OK" -eq 1 ]; then
  echo "  OK: 各contentがcolumns(37)以内に切り詰められている"
else
  fail=1
fi

echo "=== test: contextWindowSize不在（モデル未解決、公式ドキュメント記載の欠落パターン） ==="
NO_CTXSIZE_JSON='{"columns":80,"tasks":[{"id":"t1","label":"Investigating foo","status":"running","tokenCount":500}]}'
OUTPUT="$(echo "$NO_CTXSIZE_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_contains "$OUTPUT" "Investigating foo" "labelが表示される"
assert_contains "$OUTPUT" "500tok" "1000未満のtokenCountはk単位に変換されずそのまま表示される"
assert_not_contains "$OUTPUT" "%" "contextWindowSize不在時は%表示が出ない"

echo "=== test: name/label/descriptionがすべて無い（typeへフォールバック） ==="
NO_LABEL_JSON='{"columns":80,"tasks":[{"id":"t2","type":"external_agent","status":"running","tokenCount":0}]}'
OUTPUT="$(echo "$NO_LABEL_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_contains "$OUTPUT" "external_agent" "label/name/description不在時はtypeにフォールバックする"

echo "=== test: nameのみ存在するケース（実機ではlabel優先だがname単独ケースも許容） ==="
NAME_ONLY_JSON='{"columns":80,"tasks":[{"id":"t3","name":"security-reviewer","status":"running","tokenCount":0}]}'
OUTPUT="$(echo "$NAME_ONLY_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_contains "$OUTPUT" "security-reviewer" "nameが表示される"

echo "=== test: tasks配列が空 ==="
EMPTY_TASKS_JSON='{"columns":80,"tasks":[]}'
OUTPUT="$(echo "$EMPTY_TASKS_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_equal "$OUTPUT" "" "tasksが空配列のときは出力なし"

echo "=== test: tasksフィールド自体が不在 ==="
NO_TASKS_JSON='{"columns":80}'
OUTPUT="$(echo "$NO_TASKS_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_equal "$OUTPUT" "" "tasksフィールド不在のときは出力なし"

echo "=== test: columns不在時は既定幅(80)で切り詰められる ==="
NO_COLUMNS_JSON='{"tasks":[{"id":"t4","label":"short","status":"running","tokenCount":0}]}'
OUTPUT="$(echo "$NO_COLUMNS_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_contains "$OUTPUT" "short" "columns不在でもエラーにならず出力される"

echo "=== test: status不明値は汎用アイコンにフォールバック ==="
UNKNOWN_STATUS_JSON='{"columns":80,"tasks":[{"id":"t5","label":"mystery","status":"blocked","tokenCount":0}]}'
OUTPUT="$(echo "$UNKNOWN_STATUS_JSON" | bash "$SUBAGENT_STATUSLINE")"
assert_contains "$OUTPUT" "• mystery" "未知のstatus値は汎用アイコン(•)で表示される"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
