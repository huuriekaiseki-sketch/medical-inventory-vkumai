#!/usr/bin/env bash
set -euo pipefail

# issue #429: agents設定(model/effort)変更時の効果測定用baselineスナップショットを
# logs/loop-observability.jsonl・logs/subagent-skeleton.jsonl（・存在すればlogs/otel-debug-collector.jsonl）
# から集計し、docs/agents/baselines/<date>.json としてgit管理下に書き出す。
#
# 背景: logs/ はgitignore対象のため、変更前(before)のデータが次回セッションでは
# 消えている(issue #419のbefore/after比較が構造的に実施不能だった原因)。
# 集計結果だけをスナップショットとしてコミットする形でこれを解消する。
#
# 集計可能な範囲: logs/subagent-skeleton.jsonlのSubagentStart/SubagentStopペアから
# agentType別の実行件数・所要時間(ms)を算出する。rounds・findingCountはWorkflowの
# 戻り値(stats)にのみ存在し、現状どのJSONLにも永続化されていないため、この集計
# スクリプトでは算出できない（Workflow完了直後にオーケストレーターが手動で
# docs/agents/baselines/配下に追記する運用で補う。issue #429スコープ外の
# 常時記録化は別issue「OTelローカルcollectorの常時記録化」に委ねる）。
# tokens/costUsdはloop-observability.jsonl側が現状null固定のため、非nullの値のみ集計に含める。
#
# 使い方: scripts/snapshot-agent-baseline.sh [--date YYYY-MM-DD] [--out-dir docs/agents/baselines]

DATE="$(date -u +%Y-%m-%d)"
OUT_DIR="docs/agents/baselines"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --date) DATE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

LOOP_OBS_FILE="logs/loop-observability.jsonl"
SKELETON_FILE="logs/subagent-skeleton.jsonl"
OTEL_DEBUG_FILE="logs/otel-debug-collector.jsonl"

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/${DATE}.json"

# --- subagent-skeleton.jsonlからagentType別の実行件数・所要時間を集計 ---
SKELETON_SUMMARY="[]"
if [ -f "$SKELETON_FILE" ]; then
  SKELETON_SUMMARY="$(python3 - "$SKELETON_FILE" <<'PYEOF'
import json, sys
from collections import defaultdict

path = sys.argv[1]
starts = {}
by_type = defaultdict(lambda: {"runs": 0, "totalDurationMs": 0, "durationSamples": 0})

with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        agent_id = rec.get("agentId")
        agent_type = rec.get("agentType") or "(unknown)"
        event = rec.get("hookEvent")
        ts = rec.get("timestamp")
        if event == "SubagentStart" and agent_id:
            starts[agent_id] = {"timestamp": ts, "agentType": agent_type}
        elif event == "SubagentStop" and agent_id:
            entry = by_type[agent_type]
            entry["runs"] += 1
            start = starts.get(agent_id)
            if start and start.get("timestamp") and ts:
                from datetime import datetime
                fmt = "%Y-%m-%dT%H:%M:%SZ"
                try:
                    t0 = datetime.strptime(start["timestamp"], fmt)
                    t1 = datetime.strptime(ts, fmt)
                    delta_ms = int((t1 - t0).total_seconds() * 1000)
                    if delta_ms >= 0:
                        entry["totalDurationMs"] += delta_ms
                        entry["durationSamples"] += 1
                except ValueError:
                    pass

result = []
for agent_type, entry in sorted(by_type.items()):
    avg = entry["totalDurationMs"] // entry["durationSamples"] if entry["durationSamples"] else None
    result.append({
        "agentType": agent_type,
        "runs": entry["runs"],
        "avgDurationMs": avg,
        "totalDurationMs": entry["totalDurationMs"] if entry["durationSamples"] else None,
    })
print(json.dumps(result, ensure_ascii=False))
PYEOF
)"
fi

# --- loop-observability.jsonlからagent別の件数・非nullのtokens/costUsdを集計 ---
LOOP_OBS_SUMMARY="[]"
if [ -f "$LOOP_OBS_FILE" ]; then
  LOOP_OBS_SUMMARY="$(python3 - "$LOOP_OBS_FILE" <<'PYEOF'
import json, sys
from collections import defaultdict

path = sys.argv[1]
by_agent = defaultdict(lambda: {"entries": 0, "withTokens": 0, "totalTokens": 0, "withCostUsd": 0, "totalCostUsd": 0.0})

with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        agent = rec.get("agent") or "(unknown)"
        entry = by_agent[agent]
        entry["entries"] += 1
        if rec.get("tokens") is not None:
            entry["withTokens"] += 1
            entry["totalTokens"] += rec["tokens"]
        if rec.get("costUsd") is not None:
            entry["withCostUsd"] += 1
            entry["totalCostUsd"] += rec["costUsd"]

result = []
for agent, entry in sorted(by_agent.items()):
    result.append({
        "agent": agent,
        "entries": entry["entries"],
        "totalTokens": entry["totalTokens"] if entry["withTokens"] else None,
        "totalCostUsd": entry["totalCostUsd"] if entry["withCostUsd"] else None,
    })
print(json.dumps(result, ensure_ascii=False))
PYEOF
)"
fi

OTEL_DEBUG_PRESENT="false"
[ -f "$OTEL_DEBUG_FILE" ] && OTEL_DEBUG_PRESENT="true"

TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -n \
  --arg generatedAt "$TIMESTAMP" \
  --argjson subagentSkeletonByType "$SKELETON_SUMMARY" \
  --argjson loopObservabilityByAgent "$LOOP_OBS_SUMMARY" \
  --argjson otelDebugCollectorPresent "$OTEL_DEBUG_PRESENT" \
  '{
    generatedAt: $generatedAt,
    note: "rounds/findingCountはWorkflow戻り値にのみ存在し現状永続化されていないため、Workflow完了直後にオーケストレーターがこのファイルへ手動で追記すること(issue #429)。",
    subagentSkeletonByType: $subagentSkeletonByType,
    loopObservabilityByAgent: $loopObservabilityByAgent,
    otelDebugCollectorPresent: $otelDebugCollectorPresent
  }' > "$OUT_FILE"

echo "baseline snapshotを書き出しました: $OUT_FILE"
