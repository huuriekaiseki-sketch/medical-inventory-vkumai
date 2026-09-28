#!/usr/bin/env bash
set -uo pipefail

# PreToolUse hook（Bash）。このセッションが `supabase start` でローカル Supabase を**起動した側**なら印を残す。
# 相方は scripts/stop-supabase-on-session-end.sh（SessionEnd）で、印があるセッションの終了時だけ止める。
#
# WHY(2026-09-28、ユーザー指示): ローカル Supabase（Docker）は「使いたいときに起動し、使い終わったら必ず止める」。
#   止め忘れは Docker を占有し続け、追記専用の表（audit_log 等）が積み上がる（1 日で 1,160 行の実測）。
#   止める側を機械化するには「誰が起動したか」が要る——並行セッション（worktree）が同じローカル Supabase を
#   共有するので、起動していないセッションが終了時に止めると、使っている側のテストが落ちる。
#   そこで **起動前に動いていなかったときだけ** 印を残す（既に動いていれば自分は起動側ではない）。
#
# 判定はブロックしない（常に exit 0・出力なし）。jq が無ければ何もしない（印が残らず、止めない側に倒れる）。
#
# 環境変数（テスト用の注入ポイント）:
#   SUPABASE_BIN          supabase CLI のパス（既定: PATH の supabase）
#   SUPABASE_MARKER_DIR   印の置き場（既定: <リポジトリ>/logs/supabase-started-by。logs/ は git 管理外）
command -v jq >/dev/null 2>&1 || exit 0

INPUT="$(cat)"
TOOL_NAME="$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')"
[ "$TOOL_NAME" = "Bash" ] || exit 0
COMMAND="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // ""')"
[ -n "$SESSION_ID" ] || exit 0

# 先頭の空白を除き、`supabase start`（引数付きも可）で始まるものだけを見る。
# `echo supabase start` や `git grep supabase start` のような前置は対象外。
TRIMMED="$(printf '%s' "$COMMAND" | sed -E 's/^[[:space:]]+//')"
case "$TRIMMED" in
  "supabase start"|"supabase start "*) ;;
  *) exit 0 ;;
esac

SUPABASE_BIN="${SUPABASE_BIN:-supabase}"
command -v "$SUPABASE_BIN" >/dev/null 2>&1 || exit 0

# 既に動いていれば、このセッションは起動側ではない（印を残さない）
if "$SUPABASE_BIN" status >/dev/null 2>&1; then
  exit 0
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
MARKER_DIR="${SUPABASE_MARKER_DIR:-$REPO_ROOT/logs/supabase-started-by}"
mkdir -p "$MARKER_DIR" 2>/dev/null || exit 0
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$MARKER_DIR/$SESSION_ID" 2>/dev/null || true
exit 0
