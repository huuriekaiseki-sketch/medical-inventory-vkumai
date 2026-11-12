#!/bin/bash
# WHY: issue #429向けのbaselineスナップショット集計スクリプト(scripts/snapshot-agent-baseline.sh)の回帰テスト。
# 合成したlogs/loop-observability.jsonl・logs/subagent-skeleton.jsonlを一時ディレクトリに置き、
# 期待通りの集計結果がdocs/agents/baselines/<date>.json相当の出力に反映されることを確認する。
#
# 実行: bash scripts/snapshot-agent-baseline.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/snapshot-agent-baseline.sh"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

TMP_ROOT="$(mktemp -d)"
mkdir -p "$TMP_ROOT/logs" "$TMP_ROOT/out"

cat > "$TMP_ROOT/logs/subagent-skeleton.jsonl" <<'EOF'
{"timestamp":"2026-07-16T00:00:00Z","hookEvent":"SubagentStart","agentId":"a1","agentType":"sweep-ui"}
{"timestamp":"2026-07-16T00:01:00Z","hookEvent":"SubagentStop","agentId":"a1","agentType":"sweep-ui"}
{"timestamp":"2026-07-16T00:02:00Z","hookEvent":"SubagentStart","agentId":"a2","agentType":"sweep-ui"}
{"timestamp":"2026-07-16T00:04:00Z","hookEvent":"SubagentStop","agentId":"a2","agentType":"sweep-ui"}
{"timestamp":"2026-07-16T00:05:00Z","hookEvent":"SubagentStop","agentId":"internal-1","agentType":"","lastAssistantMessage":"PR を作って"}
{"timestamp":"2026-07-16T00:06:00Z","hookEvent":"SubagentStop","agentId":"hook-agent-0001"}
{"timestamp":"2026-07-16T00:07:00Z","hookEvent":"SubagentStart","agentId":"a3","agentType":"reviewer"}
{"timestamp":"2026-07-16T00:07:30Z","hookEvent":"SubagentStop","agentId":"a3","agentType":""}
{"timestamp":"2026-07-16T00:08:00Z","hookEvent":"SubagentHandback","agentId":"a4","agentType":"web-fetch","message":"報告","messageLength":2}
EOF

cat > "$TMP_ROOT/logs/loop-observability.jsonl" <<'EOF'
{"timestamp":"2026-07-16T00:00:00Z","agent":"reviewer","tokens":1000,"costUsd":0.05}
{"timestamp":"2026-07-16T00:05:00Z","agent":"reviewer","tokens":null,"costUsd":null}
EOF

cd "$TMP_ROOT"
OUT="$(bash "$SCRIPT" --date test-day --out-dir out)"
cd - > /dev/null

echo "=== scenario 1: sweep-uiの実行件数・所要時間 ==="
RUNS="$(jq -r '.subagentSkeletonByType[] | select(.agentType=="sweep-ui") | .runs' "$TMP_ROOT/out/test-day.json")"
assert_eq "$RUNS" "2" "sweep-uiのruns=2"
AVG="$(jq -r '.subagentSkeletonByType[] | select(.agentType=="sweep-ui") | .avgDurationMs' "$TMP_ROOT/out/test-day.json")"
assert_eq "$AVG" "90000" "sweep-uiのavgDurationMs=90000（60秒+120秒の平均）"

echo "=== scenario 2: loop-observabilityのtokens/costUsd集計（nullは除外） ==="
TOTAL_TOKENS="$(jq -r '.loopObservabilityByAgent[] | select(.agent=="reviewer") | .totalTokens' "$TMP_ROOT/out/test-day.json")"
assert_eq "$TOTAL_TOKENS" "1000" "reviewerのtotalTokens=1000（nullエントリは除外）"
ENTRIES="$(jq -r '.loopObservabilityByAgent[] | select(.agent=="reviewer") | .entries' "$TMP_ROOT/out/test-day.json")"
assert_eq "$ENTRIES" "2" "reviewerのentries=2（tokens null含む全件）"

# WHY（issue #928）: 骨格記録の SubagentStop 行の半分強は subagent のものではなく、本体の内部 agent
# （次の入力の候補を作る agent・compaction の要約・agent 型 hook の評価役）が出している。これらは agentType が空で、
# SubagentStart を出さない。以前はこの行を "(unknown)" の runs に数えていて、2026-11-12 の実データでは
# (unknown) が 1,653 runs・所要時間 null で種類別の最大の行になっていた（基準値が subagent の実行件数を表さない）。
# 3〜6 は、この行を runs から除き、除いた件数を別の欄に残すことの RED fixture と、その対。
echo "=== scenario 3: agentType が空で SubagentStart も無い SubagentStop は runs に数えない（issue #928） ==="
UNKNOWN_ROWS="$(jq -r '[.subagentSkeletonByType[] | select(.agentType=="(unknown)")] | length' "$TMP_ROOT/out/test-day.json")"
assert_eq "$UNKNOWN_ROWS" "0" "(unknown) の行が出力に無い"
TOTAL_RUNS="$(jq -r '[.subagentSkeletonByType[].runs] | add' "$TMP_ROOT/out/test-day.json")"
assert_eq "$TOTAL_RUNS" "3" "runs の合計は subagent の 3 件（sweep-ui 2 + reviewer 1）"

echo "=== scenario 4: 除いた件数は subagentSkeletonExcluded に残す（黙って捨てない） ==="
EXCLUDED="$(jq -r '.subagentSkeletonExcluded.emptyAgentTypeStops' "$TMP_ROOT/out/test-day.json")"
assert_eq "$EXCLUDED" "2" "除いた SubagentStop は 2 件（agentType が空文字のものと、キー自体が無いもの）"

echo "=== scenario 5（対）: SubagentStop の agentType が空でも、同じ agentId の SubagentStart に種類があればその種類で数える ==="
REVIEWER_RUNS="$(jq -r '[.subagentSkeletonByType[] | select(.agentType=="reviewer") | .runs] | add' "$TMP_ROOT/out/test-day.json")"
assert_eq "$REVIEWER_RUNS" "1" "reviewer の runs=1（Start の種類で数える。除かない）"
REVIEWER_AVG="$(jq -r '.subagentSkeletonByType[] | select(.agentType=="reviewer") | .avgDurationMs' "$TMP_ROOT/out/test-day.json")"
assert_eq "$REVIEWER_AVG" "30000" "reviewer の avgDurationMs=30000（Start と Stop の差）"

echo "=== scenario 6: 骨格記録が無いときも subagentSkeletonExcluded は 0 で出す（欄の有無で形が変わらない） ==="
TMP_EMPTY="$(mktemp -d)"
mkdir -p "$TMP_EMPTY/out"
cd "$TMP_EMPTY"
bash "$SCRIPT" --date test-day --out-dir out > /dev/null
cd - > /dev/null
EXCLUDED_EMPTY="$(jq -r '.subagentSkeletonExcluded.emptyAgentTypeStops' "$TMP_EMPTY/out/test-day.json")"
assert_eq "$EXCLUDED_EMPTY" "0" "骨格記録が無ければ除いた件数は 0"
BY_TYPE_EMPTY="$(jq -r '.subagentSkeletonByType | length' "$TMP_EMPTY/out/test-day.json")"
assert_eq "$BY_TYPE_EMPTY" "0" "骨格記録が無ければ種類別は空配列"
rm -rf "$TMP_EMPTY"

rm -rf "$TMP_ROOT"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
