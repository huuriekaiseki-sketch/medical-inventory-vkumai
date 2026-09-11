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
  if grep -qF -- "$2" <<<"$1"; then ok "$3"; else ng "$3" "期待 $2 / 実際 $1"; fi
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
# WHY(キャッシュ読み込み分を取りこぼさない): `input_tokens` は**キャッシュから読んだ分を含まない**。
#      実測の 1 回は入力 20 に対しキャッシュ読み 17,547 で、入力だけ出すと 3 桁小さく見える
assert_contains "$U" '"cacheReadTokens":17547' "キャッシュから読んだ入力も取り出す"

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

echo "=== scenario 8: キャッシュから読んだ入力を、入力トークンに混ぜず別に積む ==="
# WHY: 価格が違うので足すと別の嘘になる。**並べて出す**ために別々に持つ
EVAL_INPUT_TOKENS=0
EVAL_CACHE_READ_TOKENS=0
EVAL_USAGE_SAMPLES=0
accumulate_usage '{"costUsd":0.1,"inputTokens":6,"outputTokens":465,"cacheReadTokens":17547}'
assert_eq "$EVAL_INPUT_TOKENS" "6" "入力トークンにキャッシュ分を足さない"
assert_eq "$EVAL_CACHE_READ_TOKENS" "17547" "キャッシュ分は別に積む"

echo "=== scenario 9: 記録に「未コミットかどうか」を残す（どの版を測ったかを言えるように） ==="
# WHY(2026-09-10、レビュー R11): 木のハッシュは HEAD のもの。ところが入力の出どころが違う。
#   - fixture は**作業ツリー**から読む → 未コミットだと記録の fixturesTree が実態とずれる
#   - プロンプトは**clone（HEAD）**から読む → 未コミットの変更は評価に入っていない
#   ずれ方が逆なので、1 つの真偽値に潰さず両方を残す。
FX="$(mktemp -d)"
git -C "$FX" init -q
git -C "$FX" config user.email test@example.test
git -C "$FX" config user.name t
mkdir -p "$FX/.claude/workflows" "$FX/scripts/eval-fixtures" "$FX/docs/agents"
printf 'x\n' > "$FX/.claude/workflows/a.js"
printf 'y\n' > "$FX/scripts/eval-fixtures/b.json"
git -C "$FX" add -A
git -C "$FX" commit -qm base

RUNS="$FX/docs/agents/eval-runs.jsonl"
EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" record_eval_run "t" "set" 1 1 "$(date +%s)" "m"
CLEAN_ROW="$(tail -n 1 "$RUNS")"
assert_contains "$CLEAN_ROW" '"agentsTree"' "エージェントの定義も条件に残す（手順を変えた前後を混ぜない）"
assert_contains "$CLEAN_ROW" '"judgeBlob"' "採点器も条件に残す（合否の意味が変われば比べない）"
assert_contains "$CLEAN_ROW" '"agentsDirty": false' "エージェント定義の未コミットも見る"
assert_contains "$CLEAN_ROW" '"fixturesDirty": false' "きれいなら false"
assert_contains "$CLEAN_ROW" '"workflowsDirty": false' "きれいなら false（プロンプト側）"

# fixture だけを未コミットで書き換える
printf 'y2\n' > "$FX/scripts/eval-fixtures/b.json"
EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" record_eval_run "t" "set" 1 1 "$(date +%s)" "m"
DIRTY_ROW="$(tail -n 1 "$RUNS")"
assert_contains "$DIRTY_ROW" '"fixturesDirty": true' "fixture が未コミットなら true"
assert_contains "$DIRTY_ROW" '"workflowsDirty": false' "触っていない側は false のまま（混ぜない）"

echo "=== scenario 10: 実コードへの指摘の件数を記録する（0 と「読めなかった」を混ぜない） ==="
# WHY(2026-09-10): 陰性対照は fixture のパスに結びついた指摘しか過検出に数えないので、
#      実在ファイルへの誤指摘が 0 件として素通りしていた。件数を残して増減を追う。
EVAL_FINDINGS_REPORTED=5 EVAL_FINDINGS_SAMPLES=2 EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" \
  record_eval_run "t" "set" 1 1 "$(date +%s)" "m"
CNT_ROW="$(tail -n 1 "$RUNS")"
assert_contains "$CNT_ROW" '"findingsReported": 5' "指摘の件数を残す"
assert_contains "$CNT_ROW" '"findingsSamples": 2' "何件分から数えたかも残す"

# 読めなかった回は件数の欄を作らず、別に数える
EVAL_FINDINGS_REPORTED=0 EVAL_FINDINGS_SAMPLES=0 EVAL_FINDINGS_UNREADABLE=2 \
  EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" record_eval_run "t" "set" 1 1 "$(date +%s)" "m"
UNREAD_ROW="$(tail -n 1 "$RUNS")"
assert_contains "$UNREAD_ROW" '"findingsUnreadable": 2' "読めなかった回を別に数える"
if grep -qF '"findingsReported"' <<<"$UNREAD_ROW"; then
  ng "読めなかっただけなのに 0 件と記録した"
else
  ok "読めなかった回を「0 件」と言わない"
fi

# プロンプト側も未コミットにする
printf 'x2\n' > "$FX/.claude/workflows/a.js"
EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" record_eval_run "t" "set" 1 1 "$(date +%s)" "m"
BOTH_ROW="$(tail -n 1 "$RUNS")"
assert_contains "$BOTH_ROW" '"workflowsDirty": true' "プロンプトが未コミットなら true"
rm -rf "$FX"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
