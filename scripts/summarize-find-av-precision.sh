#!/usr/bin/env bash
set -euo pipefail

# issue #432: logs/find-av-precision.jsonl（scripts/log-find-av-precision.shが書き出す）を
# lens別・feature別に集計する。Find指摘のAdversarial Verify生存率であり、Sweep指摘の
# precisionではない点に注意（.claude/workflows/lib/find-av-precision.jsのコメント参照）。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/find-av-precision.jsonl"
OUT=""

usage() {
  echo "Usage: $0 [--log-file PATH] [--out PATH]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$LOG_FILE" ]]; then
  echo "Log file not found: $LOG_FILE" >&2
  exit 1
fi

SUMMARY="$(jq -s -r '
  . as $all
  | ($all | length) as $runs
  | ($all | map(.verifiedCount // 0) | add) as $totalVerified
  | ($all | map(.survivedCount // 0) | add) as $totalSurvived
  | "# Find→Adversarial Verify Precision Summary",
    "",
    "（Find指摘のAV生存率。Sweep指摘のprecisionではない）",
    "",
    "## 全体",
    "- 記録された実行回数: \($runs)",
    "- 検証件数合計: \($totalVerified)",
    "- 生存件数合計（minor自動生存含む）: \($totalSurvived)",
    "",
    "## Feature別",
    (
      if $runs == 0 then empty
      else
        ($all | group_by(.feature)[] |
          . as $g |
          ($g[0].feature) as $feature |
          ($g | length) as $runCount |
          ($g | map(.verifiedCount // 0) | add) as $verified |
          ($g | map(.survivedCount // 0) | add) as $survived |
          "### \($feature)",
          "- 実行回数: \($runCount)",
          "- 検証件数: \($verified)",
          "- 生存件数: \($survived)",
          ""
        )
      end
    ),
    "## lens別（全実行を通した累計）",
    (
      if $runs == 0 then empty
      else
        ($all | map(.byLens // {}) | reduce .[] as $bl (
            {};
            reduce ($bl | keys[]) as $lens (
              .;
              .[$lens].verified = ((.[$lens].verified // 0) + ($bl[$lens].verified // 0))
              | .[$lens].survived = ((.[$lens].survived // 0) + ($bl[$lens].survived // 0))
            )
          )
        ) as $lensTotals
        | ($lensTotals | keys[] | . as $lens |
            "- \($lens): 検証\($lensTotals[$lens].verified)件 / 生存\($lensTotals[$lens].survived)件"
          )
      end
    )
' "$LOG_FILE")"

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' "$SUMMARY" > "$OUT"
else
  printf '%s\n' "$SUMMARY"
fi
