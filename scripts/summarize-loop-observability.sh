#!/usr/bin/env bash
set -euo pipefail

LOG_FILE="logs/loop-observability.jsonl"
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
  def fmtList: map(if . == null then "(null)" else . end) | sort | unique | join(", ");
  . as $all
  | ($all | length) as $total
  | ($all | map(select(.loop == "agentic")) | length) as $agentic
  | ($all | map(select(.loop == "developer")) | length) as $developer
  | ($all | map(select(.loop == "external")) | length) as $external
  | ($all | map(select(.result == "pass")) | length) as $pass
  | ($all | map(select(.result == "fail")) | length) as $fail
  | ($all | map(select(.result != "pass" and .result != "fail")) | length) as $other
  | "# Loop Observability Summary",
    "",
    "## 全体",
    "- 総レコード数: \($total)",
    "- loop別: agentic=\($agentic), developer=\($developer), external=\($external)",
    "- 結果: pass=\($pass), fail=\($fail), other=\($other)",
    "",
    "## Feature別",
    (
      if $total == 0 then empty
      else
        ($all | group_by(.feature)[] |
          . as $g |
          ($g[0].feature) as $feature |
          ($g | length) as $attempts |
          ($g | map(select(.result == "pass")) | length) as $p |
          ($g | map(.model) | fmtList) as $models |
          ($g | map(.agent) | fmtList) as $agents |
          "### \($feature)",
          "- 試行回数: \($attempts)",
          "- 成功: \($p)/\($attempts)",
          "- 使用モデル: \($models)",
          "- agent: \($agents)",
          ""
        )
      end
    ),
    "## 失敗一覧",
    (
      ($all | map(select(.result == "fail"))) as $fails
      | if ($fails | length) == 0 then "- なし"
        else ($fails[] | "- [\(.timestamp)] loop=\(.loop) agent=\(.agent) feature=\(.feature) attempt=\(.attempt) scenario=\"\(.scenario)\" reason=\"\(.reason)\"")
        end
    )
' "$LOG_FILE")"

if [[ -n "$OUT" ]]; then
  mkdir -p "$(dirname "$OUT")"
  printf '%s\n' "$SUMMARY" > "$OUT"
else
  printf '%s\n' "$SUMMARY"
fi
