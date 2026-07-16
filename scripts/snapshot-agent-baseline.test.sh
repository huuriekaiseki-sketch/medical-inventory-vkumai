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

rm -rf "$TMP_ROOT"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
