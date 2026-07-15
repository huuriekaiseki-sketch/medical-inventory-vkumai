#!/usr/bin/env bash
set -euo pipefail

# 検証サブエージェント(scripts/verify-claims.sh)の効果測定(issue #355)。
# 「fail-open(検証プロセス自体の失敗によるexit 0)が静かに常態化すると、
# 気づかないまま『動いていない検証装置』になる」(docs/agents/decisions.md
# 「なぜ新しい運用ルールに検知手段を先に決める原則を導入したか」参照)ことへの
# 機械検知。実際にclaude -pを呼んだ試行(verifier_called=true)のうち、直近N件が
# 連続でfail_openなら警告してexit 1する。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md の「効果測定」節

LOG_FILE="logs/verify-claims-observability.jsonl"
STREAK_THRESHOLD=5

usage() {
  echo "Usage: $0 [--log-file PATH] [--streak-threshold N]" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --log-file) LOG_FILE="$2"; shift 2 ;;
    --streak-threshold) STREAK_THRESHOLD="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "Unknown argument: $1" >&2; usage ;;
  esac
done

if [[ ! -f "$LOG_FILE" ]]; then
  echo "verify-claims: ログファイルが存在しません($LOG_FILE)。まだ検証が実行されていないか、パスが誤っています。"
  exit 0
fi

# verifier_called=trueの行だけを時系列順(ファイルの追記順)に見て、末尾N件を取る。
# verifier_called=false(同一diff再ブロック等、LLM呼び出しを伴わない判定)は
# 「検証プロセス自体が動いたか」のシグナルとしては無関係なので除外する。
RECENT_EVENTS="$(jq -r 'select(.verifier_called == true) | .event' "$LOG_FILE" 2>/dev/null | tail -n "$STREAK_THRESHOLD")"
RECENT_COUNT="$(printf '%s\n' "$RECENT_EVENTS" | grep -c . || true)"

if [ "$RECENT_COUNT" -lt "$STREAK_THRESHOLD" ]; then
  echo "verify-claims: 検証プロセス呼び出しの件数が閾値(${STREAK_THRESHOLD})未満のため、連続fail-open検知はスキップしました(件数=${RECENT_COUNT})。"
  exit 0
fi

NON_FAIL_OPEN_COUNT="$(printf '%s\n' "$RECENT_EVENTS" | grep -vc '^fail_open$' || true)"

if [ "$NON_FAIL_OPEN_COUNT" -eq 0 ]; then
  echo "verify-claims: 警告: 直近${STREAK_THRESHOLD}回の検証プロセス呼び出しが連続でfail-openしています。claude -pサブプロセス・認証・ネットワーク等、検証エージェント自体が機能していない可能性があります。" >&2
  exit 1
fi

echo "verify-claims: 直近${STREAK_THRESHOLD}回中、連続fail-openは検知されませんでした。"
exit 0
