#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# SessionStart hookから呼ばれる。issue #430: settings.local.jsonでOTel送出を有効化した
# （CLAUDE_CODE_ENABLE_TELEMETRY=1）にもかかわらず、ローカルcollector
# （scripts/otel-debug-collector.mjs等）を起動し忘れている状態を機械的に検知して警告する。
# block（session開始そのものの停止）はできない前提のためwarningのみ。
#
# 「起動し忘れても気づける」形にする、という issue #430・issue #411原則への対応。
# OTelを有効化していない（デフォルト）環境では何もしない。

cd "$(dirname "$0")/.."

if [ "${CLAUDE_CODE_ENABLE_TELEMETRY:-}" != "1" ]; then
  exit 0
fi

ENDPOINT="${OTEL_EXPORTER_OTLP_ENDPOINT:-http://localhost:4318}"

if ! command -v curl >/dev/null 2>&1; then
  exit 0
fi

# collectorはPOST以外のメソッドやルート("/")には応答を用意していないことがあるため、
# 「接続自体ができるか」だけを短いタイムアウトで確認する（内容の正しさまでは見ない）
if curl -s -o /dev/null --max-time 2 "${ENDPOINT}/v1/metrics" 2>/dev/null; then
  exit 0
fi

MSG="OTelテレメトリが有効（CLAUDE_CODE_ENABLE_TELEMETRY=1）ですが、送信先 ${ENDPOINT} に接続できませんでした。ローカルcollectorを起動し忘れている可能性があります（\`node scripts/otel-debug-collector.mjs\` 等）。起動しない場合、tokens/costのメトリクスは記録されずに失われます（docs/agents/observability-internals.md「OpenTelemetryと自作JSONLの役割分担」参照）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
