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
    "## Agent別（品質ゲートの発火実績。blocked状態はこのログに記録されないため対象外。issue #412）",
    (
      if $total == 0 then empty
      else
        ($all | group_by(.agent)[] |
          . as $g |
          ($g[0].agent) as $agent |
          ($g | length) as $attempts |
          ($g | map(select(.result == "pass")) | length) as $p |
          ($g | map(select(.result == "fail")) | length) as $f |
          "- \($agent): 試行\($attempts)件 / pass=\($p) / fail=\($f)"
        ),
        (
          ($all | group_by(.agent) | map(select(any(.[]; .result == "fail")) | .[0].agent)) as $everFailed
          | ($all | group_by(.agent) | map(.[0].agent) - $everFailed) as $neverFailed
          | if ($neverFailed | length) > 0 then
              "- 一度もfailを返していないagent: \($neverFailed | sort | join(", "))"
            else empty end
        ),
        ""
      end
    ),
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
          ($g | map(.tokens // 0) | add) as $tokens |
          ($g | map(select(.tokens != null)) | length) as $tokensKnown |
          ($g | map(.costUsd // 0) | add) as $cost |
          ($g | map(select(.costUsd != null)) | length) as $costKnown |
          "### \($feature)",
          "- 試行回数: \($attempts)",
          "- 成功: \($p)/\($attempts)",
          "- 使用モデル: \($models)",
          "- agent: \($agents)",
          "- tokens合計: \($tokens)（\($tokensKnown)/\($attempts)件で判明）",
          "- costUsd合計: \($cost | (.*100|round)/100)（\($costKnown)/\($attempts)件で判明）",
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
