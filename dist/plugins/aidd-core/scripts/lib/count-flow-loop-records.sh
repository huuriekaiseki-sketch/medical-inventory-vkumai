#!/usr/bin/env bash
# loop-observability.jsonl のうち「AIDD フローのサブエージェントが書いた行」を数える（issue #812）。
#
# WHY: gap check は「フローの記録が何件増えたか」を見たいのに、総行数（wc -l）で数えていた。
# 同じログには E2E の実行も 1 テストごとに 1 行書くので、フロー中に E2E が 1 回走ると 100 行前後が
# 上乗せされ、判定（actual !== expected）は必ず警告になる。毎回鳴る警告は、記録漏れなのか E2E の
# 雑音なのか読み分けられない。2026-09-20 の実測: actual=140 / expected=21、うち 116 行が E2E。
#
# WHY(before と after がここを共有する): before（record-gap-check-state.sh）と
# after（check-loop-observability-gap.sh）が別々の数え方を持つと、差は決して合わない（PR #804 で
# 「別々の場所を数えていた」形で一度踏んだ）。数え方は 1 か所に置く。
#
# WHY(loop では絞らない): reviewer の記録は E2E と同じ loop=developer で書かれる（実測）。
# agentic だけ数えると reviewer が落ちて、今度は少なすぎる側に振れる。
#
# WHY(読めない行は数える): JSON として読めない行を捨てると、ログが壊れたときに静かに少なく数える。
# 誰が書いたか分からない行は除外せず、従来（総行数）と同じ向きに倒す。
#
# 使い方: source してから count_flow_loop_records <ログのパス>

_COUNT_FLOW_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

count_flow_loop_records() {
  local log_file="$1"
  local list="$_COUNT_FLOW_LIB_DIR/non-subagent-loop-agents.json"
  if [ ! -f "$log_file" ]; then
    echo 0
    return 0
  fi
  jq -R -s --slurpfile list "$list" '
    ($list[0].agents) as $skip
    | [ split("\n")[]
        | select(length > 0)
        | (try fromjson catch null)
        | select((type == "object" and (.agent as $a | $skip | index($a)) != null) | not)
      ]
    | length
  ' "$log_file"
}
