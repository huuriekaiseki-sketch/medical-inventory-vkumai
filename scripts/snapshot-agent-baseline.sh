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

# WHY(issue #805): 書く側は全 worktree 共有の logs/ へ書く。ここが cwd 相対のままだと、git worktree から
# 動かしたときに、ほぼ空の worktree 直下のログから baseline を作ってしまう（件数が実態と合わない baseline が残る）。
# git リポジトリの外（テストのサンドボックス）では、resolve_log_dir は従来どおり cwd 相対の logs へ倒れる
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
LOG_DIR="$(resolve_log_dir)"
LOOP_OBS_FILE="$LOG_DIR/loop-observability.jsonl"
SKELETON_FILE="$LOG_DIR/subagent-skeleton.jsonl"
OTEL_DEBUG_FILE="$LOG_DIR/otel-debug-collector.jsonl"

mkdir -p "$OUT_DIR"
OUT_FILE="$OUT_DIR/${DATE}.json"

# --- subagent-skeleton.jsonlからagentType別の実行件数・所要時間を集計 ---
#
# WHY（issue #928）: agentType が空で、同じ agentId の SubagentStart も無い SubagentStop 行は runs に数えない。
# この行は subagent のものではなく、本体の内部 agent（次の入力の候補を作る agent・compaction の要約・
# agent 型 hook の評価役）が出している（2026-11-12 の調査。全期間で 1,642 行、指す transcript は 1 つも残っていない）。
# 以前は "(unknown)" として数えていて、実データでは (unknown) が 1,653 runs・所要時間 null で種類別の最大の行に
# なっていた。基準値は model / effort の変更前後で subagent の実行を比べるためのものなので、混ぜると比較が壊れる。
#
# 種類は「SubagentStop の agentType、無ければ同じ agentId の SubagentStart の agentType」で決める。Stop 側だけ
# 種類が欠けた subagent を、内部 agent と一緒に捨てないため。
#
# 除いた件数は捨てずに subagentSkeletonExcluded.emptyAgentTypeStops に残す。0 件と「数えていない」を区別でき、
# 本体の版が変わって内部 agent の出方が変わったときに、この数字の動きで気づける。
#
# 限界: web-fetch の subagent は SubagentStart / SubagentStop の hook が呼ばれない（同調査）ので、ここには載らない。
# SubagentHandback の行から補うことはしていない（所要時間が取れず、補うかどうかは issue #928 で未決）。
SKELETON_SUMMARY='{"byType":[],"excludedEmptyAgentTypeStops":0}'
if [ -f "$SKELETON_FILE" ]; then
  SKELETON_SUMMARY="$(python3 - "$SKELETON_FILE" <<'PYEOF'
import json, sys
from collections import defaultdict

path = sys.argv[1]
starts = {}
by_type = defaultdict(lambda: {"runs": 0, "totalDurationMs": 0, "durationSamples": 0})
excluded_empty_type_stops = 0

with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        rec = json.loads(line)
        agent_id = rec.get("agentId")
        agent_type = rec.get("agentType") or ""
        event = rec.get("hookEvent")
        ts = rec.get("timestamp")
        if event == "SubagentStart" and agent_id:
            starts[agent_id] = {"timestamp": ts, "agentType": agent_type}
        elif event == "SubagentStop" and agent_id:
            start = starts.get(agent_id)
            resolved_type = agent_type or (start or {}).get("agentType") or ""
            if not resolved_type:
                excluded_empty_type_stops += 1
                continue
            entry = by_type[resolved_type]
            entry["runs"] += 1
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
print(json.dumps({"byType": result, "excludedEmptyAgentTypeStops": excluded_empty_type_stops}, ensure_ascii=False))
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
  --argjson skeleton "$SKELETON_SUMMARY" \
  --argjson loopObservabilityByAgent "$LOOP_OBS_SUMMARY" \
  --argjson otelDebugCollectorPresent "$OTEL_DEBUG_PRESENT" \
  '{
    generatedAt: $generatedAt,
    note: "rounds/findingCountはWorkflow戻り値にのみ存在し現状永続化されていないため、Workflow完了直後にオーケストレーターがこのファイルへ手動で追記すること(issue #429)。",
    subagentSkeletonByType: $skeleton.byType,
    subagentSkeletonExcluded: {
      emptyAgentTypeStops: $skeleton.excludedEmptyAgentTypeStops,
      note: "agentTypeが空でSubagentStartも無いSubagentStop行は、本体の内部agent（次の入力の候補・compactionの要約・agent型hookの評価役）のものでsubagentの実行ではないため、subagentSkeletonByTypeのrunsに数えない(issue #928)。web-fetchはSubagentStart/Stopのhookが呼ばれないため、どちらにも載らない。"
    },
    loopObservabilityByAgent: $loopObservabilityByAgent,
    otelDebugCollectorPresent: $otelDebugCollectorPresent
  }' > "$OUT_FILE"

echo "baseline snapshotを書き出しました: $OUT_FILE"
