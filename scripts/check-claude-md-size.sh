#!/usr/bin/env bash
set -euo pipefail

# WHY: SessionStart hookから呼ばれる。CLAUDE.md / docs/agents/common.md
# （@importでCLAUDE.mdに実質連結される正本）は毎メッセージのプリロードとして
# 課金対象になるため、肥大化に気づかず膨張し続けるリスクがある。
# ただしこのリポジトリのcommon.mdは意図的に構造化されたAIDDフレームワークの
# 機械検知ルール集であり、「短ければ良い」わけではない（削除の判断は人間に委ねる）。
# block（session開始そのものの停止）はできない前提のためwarningのみ。
#
# 閾値は環境変数で上書き可能（デフォルトはCLAUDE.md=200行、common.md=300行。
# common.mdは@importで別ファイルとして分離されている実態を踏まえ、CLAUDE.md本体より
# 緩めの閾値にした）。

command -v wc >/dev/null 2>&1 || exit 0

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
CLAUDE_MD_LIMIT="${CLAUDE_MD_LINE_LIMIT:-200}"
COMMON_MD_LIMIT="${COMMON_MD_LINE_LIMIT:-300}"

CLAUDE_MD_PATH="$PROJECT_DIR/CLAUDE.md"
COMMON_MD_PATH="$PROJECT_DIR/docs/agents/common.md"

WARNINGS=()

if [ -f "$CLAUDE_MD_PATH" ]; then
  LINES=$(wc -l < "$CLAUDE_MD_PATH" | tr -d ' ')
  if [ "$LINES" -gt "$CLAUDE_MD_LIMIT" ]; then
    WARNINGS+=("CLAUDE.mdが${LINES}行（閾値${CLAUDE_MD_LIMIT}行）を超えています。全メッセージでプリロードされるため、不要な記述が無いか見直しを検討してください。")
  fi
fi

if [ -f "$COMMON_MD_PATH" ]; then
  LINES=$(wc -l < "$COMMON_MD_PATH" | tr -d ' ')
  if [ "$LINES" -gt "$COMMON_MD_LIMIT" ]; then
    WARNINGS+=("docs/agents/common.mdが${LINES}行（閾値${COMMON_MD_LIMIT}行）を超えています。CLAUDE.mdへの@importで全メッセージにプリロードされるため、既存ルールの棚卸しファイルへの分離（issue #486と同様の対応）を検討してください。")
  fi
fi

if [ "${#WARNINGS[@]}" -eq 0 ]; then
  exit 0
fi

MSG=$(printf '%s\n' "${WARNINGS[@]}")

if command -v jq >/dev/null 2>&1; then
  jq -n --arg msg "$MSG" '{
    systemMessage: $msg,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: $msg
    }
  }'
else
  echo "$MSG" >&2
fi
