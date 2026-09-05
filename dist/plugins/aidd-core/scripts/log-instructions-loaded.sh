#!/usr/bin/env bash
set -euo pipefail

# InstructionsLoaded hook（settings.json に登録）から呼ばれる。issue #742。
#
# なぜ: 常時ロードされる指示ファイルの量は、これまで check-claude-md-size.sh が
# 「CLAUDE.md + @import 連鎖 + paths 無しの rules」を**自前で**再現して計算していた。
# 公式の InstructionsLoaded イベントは、実際に context へ読み込まれたファイルごとに
# 1 回発火し、file_path / load_reason（session_start / nested_traversal /
# path_glob_match / include / compact）/ memory_type を渡す。これを記録すれば
# 「実際に何が読まれたか」を推測ではなく事実で持てる。自前計算との差は、
# 自前計算側の穴（読み方の仕様変更への追従漏れ）として検出できる。
#
# 記録専用の理由: 公式仕様では、このイベントの hook 出力（JSON・exit code）は
# すべて無視され、ロードを止めることも内容を変えることもできない。
# したがって文字数上限の判定は引き続き check-claude-md-size.sh（SessionStart）が担い、
# ここは logs/instructions-loaded.jsonl への追記だけを行う。
#
# 記録する項目:
#   - fileSizeBytes: ペイロードに file_size_bytes があればそれ、無ければ wc -c
#     （docs の入力例にこのフィールドは無いが、issue #742 の想定として互換で受ける）
#   - fileChars: 文字数（check-claude-md-size.sh の閾値は文字数なので突き合わせ用。
#     バイト数は日本語 1 文字 3 バイトでトークンの指標にならない、issue #716）
#   - memoryType: docs は "instructions" / "mcp_context" と書くが、2026-09-05 の実測
#     （Claude Code 2.1.258）では "User"（~/.claude/CLAUDE.md）/ "Project" が来た。
#     値の解釈はせず来たまま記録する（docs と実装の差自体が upstream-docs-review の材料）
#   - filePath は CLAUDE_PROJECT_DIR 配下なら相対にする（worktree が違っても同じファイルを
#     同じキーで集計するため。配下でなければ絶対パスのまま）
#
# fail-open: jq 不在・ペイロード不正・ファイル不在でも exit 0（記録が 1 件欠けるだけ。
# hook の失敗でセッションを止めない。docs/agents/hook-live-drill.md の型どおり、
# 無音死を疑うときは実データを流して bash -x で判定経路を見る）。
#
# テスト用の注入ポイント:
#   INSTRUCTIONS_LOADED_LOG_FILE  追記先（既定 $(resolve_log_dir)/instructions-loaded.jsonl）
#   CLAUDE_PROJECT_DIR            相対化の基準（既定 pwd）

command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="${INSTRUCTIONS_LOADED_LOG_FILE:-$(resolve_log_dir)/instructions-loaded.jsonl}"
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"

PAYLOAD="$(cat)"
[ -n "$PAYLOAD" ] || exit 0

HOOK_EVENT="$(printf '%s' "$PAYLOAD" | jq -r '.hook_event_name // empty' 2>/dev/null || true)"
FILE_PATH="$(printf '%s' "$PAYLOAD" | jq -r '.file_path // empty' 2>/dev/null || true)"
if [ "$HOOK_EVENT" != "InstructionsLoaded" ] || [ -z "$FILE_PATH" ]; then
  exit 0
fi

SESSION_ID="$(printf '%s' "$PAYLOAD" | jq -r '.session_id // empty')"
LOAD_REASON="$(printf '%s' "$PAYLOAD" | jq -r '.load_reason // empty')"
MEMORY_TYPE="$(printf '%s' "$PAYLOAD" | jq -r '.memory_type // empty')"
GLOB_PATTERN="$(printf '%s' "$PAYLOAD" | jq -r '.glob_pattern // empty')"
SIZE_FROM_PAYLOAD="$(printf '%s' "$PAYLOAD" | jq -r '.file_size_bytes // empty')"

FILE_SIZE_BYTES="$SIZE_FROM_PAYLOAD"
FILE_CHARS=""
if [ -f "$FILE_PATH" ]; then
  if [ -z "$FILE_SIZE_BYTES" ]; then
    FILE_SIZE_BYTES="$(wc -c < "$FILE_PATH" | tr -d ' ')"
  fi
  FILE_CHARS="$(jq -Rs 'length' "$FILE_PATH" 2>/dev/null || true)"
fi

REL_PATH="$FILE_PATH"
case "$FILE_PATH" in
  "$PROJECT_DIR"/*) REL_PATH="${FILE_PATH#"$PROJECT_DIR"/}" ;;
esac

mkdir -p "$(dirname "$LOG_FILE")"
TIMESTAMP="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

jq -nc \
  --arg timestamp "$TIMESTAMP" \
  --arg sessionId "$SESSION_ID" \
  --arg loadReason "$LOAD_REASON" \
  --arg filePath "$REL_PATH" \
  --arg memoryType "$MEMORY_TYPE" \
  --arg globPattern "$GLOB_PATTERN" \
  --arg fileSizeBytes "$FILE_SIZE_BYTES" \
  --arg fileChars "$FILE_CHARS" \
  '{
    timestamp: $timestamp,
    sessionId: $sessionId,
    loadReason: $loadReason,
    filePath: $filePath,
    memoryType: $memoryType
  }
  + (if $globPattern != "" then {globPattern: $globPattern} else {} end)
  + (if $fileSizeBytes != "" then {fileSizeBytes: ($fileSizeBytes | tonumber)} else {} end)
  + (if $fileChars != "" then {fileChars: ($fileChars | tonumber)} else {} end)' \
  >> "$LOG_FILE"

exit 0
