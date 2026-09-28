#!/usr/bin/env bash
set -uo pipefail

# SessionEnd hook。このセッションがローカル Supabase を起動した側（scripts/mark-supabase-started.sh が印を残した）
# なら、セッション終了時に `supabase stop` で止めて印を消す。
#
# WHY(2026-09-28、ユーザー指示): 「使い終わったら必ず止める」を人の記憶に頼らず機械化する。
#   印が無い（別セッションが起動した・自分は使っただけ）なら止めない——並行セッションのテストを巻き込まないため。
#   限界: 起動側のセッションが先に終わると、使っている別セッションのテストは落ちる（黙っては壊れない）。
#
# 常に exit 0。停止に失敗しても（Docker が落ちている等）セッション終了を妨げない。
#
# 環境変数（テスト用の注入ポイント）:
#   SUPABASE_BIN          supabase CLI のパス（既定: PATH の supabase）
#   SUPABASE_MARKER_DIR   印の置き場（既定: <リポジトリ>/logs/supabase-started-by）
command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // ""')"
[ -n "$SESSION_ID" ] || exit 0

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
MARKER_DIR="${SUPABASE_MARKER_DIR:-$REPO_ROOT/logs/supabase-started-by}"
MARKER="$MARKER_DIR/$SESSION_ID"
[ -f "$MARKER" ] || exit 0

SUPABASE_BIN="${SUPABASE_BIN:-supabase}"
if command -v "$SUPABASE_BIN" >/dev/null 2>&1; then
  # 動いているときだけ止める（既に止まっていれば stop を呼ばない）
  if "$SUPABASE_BIN" status >/dev/null 2>&1; then
    "$SUPABASE_BIN" stop >/dev/null 2>&1 || true
  fi
fi
rm -f "$MARKER" 2>/dev/null || true
exit 0
