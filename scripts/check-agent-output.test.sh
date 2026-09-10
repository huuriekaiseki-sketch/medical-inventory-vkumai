#!/usr/bin/env bash
# WHY(2026-09-10、設計提案 3「再現性と費用」の費用の側): `claude -p --output-format json` は
#      中身を**包み**（`type: "result"` のオブジェクト）に入れて返し、そこに
#      `total_cost_usd` と `usage`（入出力トークン）が付く。2026-09-10 に最小の 1 回で実測し、
#      `--json-schema` と併用できること・中身が `structured_output` に入ることを確かめた。
#
#      この包みを剥がす部品（scripts/lib/agent-output.mjs）が壊れると、
#      **eval の判定そのものが壊れる**（中身を読めない＝全件 MISS）ので、ここで固定する。
#
#      いちばん大事なのは「**包みが無い出力もそのまま通す**」こと。
#      eval のテストはエージェントをモックに差し替えており、モックは素の `{"status":"pass"}` を返す。
#      包みを前提にすると**テストが実物と違うものを測る**ことになる（C-023 と同じ形）。
#
# 実行: bash scripts/check-agent-output.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/lib/agent-output.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else ng "$3" "期待 [$2] / 実際 [$1]"; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "期待 $2 / 実際 $1"; fi
}

payload() { printf '%s' "$1" | node "$LIB" --payload; }
usage() { printf '%s' "$1" | node "$LIB" --usage; }

WRAPPED='{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.0377527,"duration_ms":3761,"usage":{"input_tokens":20,"output_tokens":146,"cache_read_input_tokens":17547},"result":"{\"status\":\"ready\"}","structured_output":{"status":"ready"}}'
BARE='{"status":"pass","detail":"ok"}'
TEXT='FINDINGS: 0
指摘なし。'

echo "=== scenario 1: 包み付きの出力から中身を取り出す ==="
assert_contains "$(payload "$WRAPPED")" '"status":"ready"' "structured_output を中身として返す"

echo "=== scenario 2: 包み付きの出力から使用量を取り出す ==="
U="$(usage "$WRAPPED")"
assert_contains "$U" '"costUsd":0.0377527' "費用を取り出す"
assert_contains "$U" '"inputTokens":20' "入力トークンを取り出す"
assert_contains "$U" '"outputTokens":146' "出力トークンを取り出す"

echo "=== scenario 3: 包みが無い出力はそのまま通す（モックが通る道） ==="
# WHY: eval のテストはモックに差し替える。包みを前提にすると**テストが実物と違うものを測る**
assert_eq "$(payload "$BARE")" "$BARE" "素の JSON はそのまま"
assert_eq "$(usage "$BARE")" "{}" "素の JSON からは使用量を取らない（0 とは言わない）"

echo "=== scenario 4: JSON ですらない出力もそのまま通す ==="
assert_contains "$(payload "$TEXT")" "指摘なし" "素のテキストはそのまま"
assert_eq "$(usage "$TEXT")" "{}" "素のテキストからは使用量を取らない"

echo "=== scenario 5: 取れなかったことと 0 だったことを混ぜない ==="
# 費用の欄が無い包み → costUsd は null（0 ではない）
NO_COST='{"type":"result","usage":{"input_tokens":5,"output_tokens":7},"structured_output":{"status":"pass"}}'
assert_contains "$(usage "$NO_COST")" '"costUsd":null' "費用が無ければ null（0 と言わない）"
assert_contains "$(usage "$NO_COST")" '"inputTokens":5' "取れる分は取る"

echo "=== scenario 6: 実物の呼び出しに --output-format json が付いている（静的確認） ==="
# WHY: 部品が正しくても、呼び出し側が包みを要求していなければ使用量は永久に取れない
for s in eval-sweep-recall.sh eval-workflow-prompts.sh; do
  if grep -q -- "--output-format json" "$SCRIPT_DIR/$s"; then
    ok "${s} が使用量を要求している"
  else
    ng "${s} に --output-format json が無い（費用を永久に取れない）"
  fi
done

echo "=== scenario 7: 使用量の足し上げは、取れなかった回を 0 円として積まない ==="
# shellcheck source=lib/record-eval-run.sh
source "$SCRIPT_DIR/lib/record-eval-run.sh"
accumulate_usage '{"costUsd":0.5,"inputTokens":10,"outputTokens":20}'
accumulate_usage '{}'
accumulate_usage '{"costUsd":0.25,"inputTokens":5,"outputTokens":5}'
assert_eq "$EVAL_USAGE_SAMPLES" "2" "取れた回だけを数える"
assert_eq "$EVAL_USAGE_MISSING" "1" "取れなかった回を別に数える"
assert_eq "$EVAL_COST_USD" "0.75" "取れた分だけを足す"
assert_eq "$EVAL_INPUT_TOKENS" "15" "入力トークンを足す"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
