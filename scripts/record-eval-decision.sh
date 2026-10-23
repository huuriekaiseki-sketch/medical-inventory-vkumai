#!/usr/bin/env bash
# プロンプト（.claude/workflows）や探索手順（.claude/agents）の変更を eval の結果で「採用した／しなかった」と
# 記録する入口。docs/agents/eval-decisions.jsonl へ 1 行追記する。
#
# WHY(2026-10-24・issue #907): Anthropic の 2026-09-28 の記事「Automating eval design and hillclimbing」——
#      **ノイズ内の改善は採用しない**／train と test の両方で改善したときだけ採用する——を、
#      ルール文書に書くだけでなく**書けない形**にする。判定は scripts/lib/scan-eval-record-shape.mjs の
#      `judge`（検査 check-eval-record-shape.test.sh と同じエンジン）で、`adopted` は条件を満たさないと
#      このスクリプトが**拒む**（exit 1、理由を名指し）。`rejected` はいつでも書ける（見送った記録も残す）。
#
#      条件（judge の中身。ここには書き写さない——同じ問いに 2 か所が答えない。E-053）:
#        4 行（変更前後 × train / test）すべてが 2 run 以上／各対で条件が同じ／未コミットのまま測った行が無い／
#        train と test の両方で、合格数の平均の改善がノイズ幅（4 行の最大）より大きい
#
# 使い方:
#   scripts/record-eval-decision.sh --decision adopted \
#     --before-train 2026-10-30T01:00:00Z --after-train 2026-10-30T02:00:00Z \
#     --before-test  2026-10-30T01:10:00Z --after-test  2026-10-30T02:10:00Z \
#     --change "sweep.js の Find 指示を締めた（1 パッチ）" [--note "..."]
#
#   timestamp は docs/agents/eval-runs.jsonl の行の `timestamp` そのまま。
#   変更前（main）と変更後（ブランチ）を、train セットと test（*-holdout）セットの両方で
#   `EVAL_RUNS=3 scripts/eval-sweep-recall.sh <layer>` のように回してから呼ぶ。
#
# 環境変数（テスト用）:
#   EVAL_RUNS_FILE       読む記録（既定 docs/agents/eval-runs.jsonl）
#   EVAL_DECISIONS_FILE  書く先（既定 docs/agents/eval-decisions.jsonl）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/scan-eval-record-shape.mjs"
RUNS_FILE="${EVAL_RUNS_FILE:-$REPO_ROOT/docs/agents/eval-runs.jsonl}"
DECISIONS_FILE="${EVAL_DECISIONS_FILE:-$REPO_ROOT/docs/agents/eval-decisions.jsonl}"

DECISION=""
BEFORE_TRAIN=""
AFTER_TRAIN=""
BEFORE_TEST=""
AFTER_TEST=""
CHANGE=""
NOTE=""
usage() {
  sed -n '/^# 使い方:/,/^# 環境変数/p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --decision) DECISION="${2:-}"; shift ;;
    --before-train) BEFORE_TRAIN="${2:-}"; shift ;;
    --after-train) AFTER_TRAIN="${2:-}"; shift ;;
    --before-test) BEFORE_TEST="${2:-}"; shift ;;
    --after-test) AFTER_TEST="${2:-}"; shift ;;
    --change) CHANGE="${2:-}"; shift ;;
    --note) NOTE="${2:-}"; shift ;;
    -h|--help) usage ;;
    *) echo "record-eval-decision: 不明な引数 '$1'" >&2; usage ;;
  esac
  shift
done

if [ "$DECISION" != "adopted" ] && [ "$DECISION" != "rejected" ]; then
  echo "record-eval-decision: --decision は adopted か rejected（いまは '${DECISION}'）" >&2
  exit 2
fi
if [ -z "$CHANGE" ]; then
  echo "record-eval-decision: --change（何を変えたか 1 行）は必須。後から読む人が何を採用したのか分からない" >&2
  exit 2
fi
if [ -z "$BEFORE_TRAIN" ] || [ -z "$AFTER_TRAIN" ] || [ -z "$BEFORE_TEST" ] || [ -z "$AFTER_TEST" ]; then
  echo "record-eval-decision: --before-train / --after-train / --before-test / --after-test の 4 つがすべて必要（train だけ・test だけでは採用の根拠にならない）" >&2
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "record-eval-decision: node が必要です" >&2; exit 2; }
if [ ! -f "$RUNS_FILE" ]; then
  echo "record-eval-decision: 記録が無い: $RUNS_FILE" >&2
  exit 1
fi

# 判定はエンジンに任せる（検査と同じ道を通す。C-023）
VERDICT="$(node "$ENGINE" judge "$RUNS_FILE" \
  --before-train "$BEFORE_TRAIN" --after-train "$AFTER_TRAIN" \
  --before-test "$BEFORE_TEST" --after-test "$AFTER_TEST")"

# 判定結果は環境変数で渡す（`printf ... |` のパイプは pipefail の下で結果が環境依存になる。C-050）
ALLOWED="$(VERDICT="$VERDICT" node -e 'process.stdout.write(JSON.parse(process.env.VERDICT).allowed ? "true" : "false")')"

if [ "$DECISION" = "adopted" ] && [ "$ALLOWED" != "true" ]; then
  echo "record-eval-decision: この結果では「採用」と書けません。理由:" >&2
  VERDICT="$VERDICT" node -e 'for (const r of JSON.parse(process.env.VERDICT).reasons) process.stderr.write("  - " + r + "\n")'
  echo "  見送るなら --decision rejected で記録を残せます（見送った記録も次の判断の材料になる）" >&2
  exit 1
fi

# 記録に失敗しても判定の結果（標準出力）は残す
mkdir -p "$(dirname "$DECISIONS_FILE")"
DECISION="$DECISION" CHANGE="$CHANGE" NOTE="$NOTE" VERDICT="$VERDICT" node -e '
const v = JSON.parse(process.env.VERDICT)
const row = {
  timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  decision: process.env.DECISION,
  change: process.env.CHANGE,
  // 判定の根拠をそのまま残す（後から「なぜ採用できたか」を記録だけで追えるように）
  allowed: v.allowed,
  noiseWidth: v.noiseWidth,
  train: v.train,
  test: v.test,
}
if (v.reasons.length > 0) row.reasons = v.reasons
if (process.env.NOTE) row.note = process.env.NOTE
require("fs").appendFileSync(process.argv[1], JSON.stringify(row) + "\n")
process.stdout.write(JSON.stringify(row) + "\n")
' "$DECISIONS_FILE"

if [ "$DECISION" = "adopted" ]; then
  echo "record-eval-decision: 採用を記録しました → $DECISIONS_FILE"
else
  echo "record-eval-decision: 見送りを記録しました → $DECISIONS_FILE"
fi
exit 0
