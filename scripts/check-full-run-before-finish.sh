#!/usr/bin/env bash
set -uo pipefail

# WHY(C-041「単体で緑にして終える」の機械化、2026-09-09):
#      検査の設計で間違えやすい型（`docs/agents/check-design-pitfalls.md`）のうち、
#      C-041 は長く **検知なし**（＝運用に頼る）だった。
#      並列の干渉・他の spec の後片付け・実行順は**単体実行では一度も再現しない**ので、
#      1 本だけ緑にして「できました」と終える形が、実際に 2026-09-09 に起きている。
#
#      鮮度の判定はもともとあったが、動くのが **SessionStart**（＝次のセッション）だった。
#      それでは「終える瞬間」に間に合わない。**同じ判定を Stop で動かす**のがこの hook。
#
#      あわせて、判定の材料を「HEAD の木」から**未コミットを含む「いまの姿」**へ広げた
#      （`scripts/lib/worktree-hash.sh`）。手元で書き換えて単体だけ回して終える、が
#      いちばんありがちな終わり方で、HEAD の木では見えなかった。
#
# WHY(セッションに 1 回・警告のみ): Stop は毎ターン走る。毎回鳴る警告は読まれなくなる（C-031）。
#      既存の check-aidd-stats-recorded.sh と同じく、同一セッションでは 2 回目以降は黙る。
#      ブロックはしない（回せない事情——DB を落としている・時間が無い——は普通にある）。
#
# 限界:
#   - **回したかどうかしか見ない。** 通した内容が十分かは見ない
#   - 記録が無い環境（別リポジトリ・plugin の導入先）では黙って終わる
#   - セッションに 1 回なので、警告を見たあとにさらに触っても再度は鳴らない
#
# 環境変数（テスト用注入ポイント）:
#   FULL_RUN_CHECK_SESSION_ID   hook stdin の session_id の代替
#   FULL_RUN_CHECK_MARKER       警告済みマーカーの置き場所
#   FULL_RUN_CHECK_ROOT         リポジトリルート（既定は CLAUDE_PROJECT_DIR / スクリプトの親）

command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${FULL_RUN_CHECK_ROOT:-${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"

cd "$REPO_ROOT" 2>/dev/null || exit 0

HOOK_INPUT=""
if [ -z "${FULL_RUN_CHECK_SESSION_ID:-}" ]; then
  HOOK_INPUT="$(cat 2>/dev/null || true)"
fi
SESSION_ID="${FULL_RUN_CHECK_SESSION_ID:-$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // empty' 2>/dev/null || true)}"
[ -n "$SESSION_ID" ] || exit 0

MARKER_FILE="${FULL_RUN_CHECK_MARKER:-$HOME/.claude/full-run-check-warned.json}"
if [ -f "$MARKER_FILE" ]; then
  WARNED="$(jq -r '.sessionId // empty' "$MARKER_FILE" 2>/dev/null || true)"
  [ "$WARNED" = "$SESSION_ID" ] && exit 0
fi

LOG_DIR="$(resolve_log_dir)"
MESSAGES=""

# $1=ラベル $2=記録ファイル $3=回し方 $4...=見張るパス
check_suite() {
  local label="$1" log="$2" runner="$3"
  shift 3
  local args=() path tree wt
  for path in "$@"; do
    # そのパスが無いリポジトリ（プラグインの導入先など）では何も言わない
    [ -d "$REPO_ROOT/$path" ] || return 0
    tree="$(git rev-parse "HEAD:$path" 2>/dev/null || echo unknown)"
    wt="$(worktree_hash "$path")"
    args+=(--tree "$path=$tree" --worktree "$path=$wt")
  done
  python3 "$SCRIPT_DIR/lib/run-freshness.py" \
    --log "$log" --label "$label" --runner "$runner" "${args[@]}" 2>/dev/null
}

INTEGRATION="$(check_suite "統合テスト" "$LOG_DIR/integration-runs.jsonl" "bash scripts/run-integration-tests.sh" supabase)"
E2E="$(check_suite "E2E" "$LOG_DIR/e2e-runs.jsonl" "bash scripts/run-e2e-tests.sh" e2e src)"

[ -n "$INTEGRATION" ] && MESSAGES="$INTEGRATION"
if [ -n "$E2E" ]; then
  [ -n "$MESSAGES" ] && MESSAGES="$MESSAGES"$'\n'
  MESSAGES="$MESSAGES$E2E"
fi

[ -z "$MESSAGES" ] && exit 0

MSG="作業を終える前に（C-041: 単体で緑にして終えない）:"$'\n'"$MESSAGES"

# マーカーを書く（書けなくても警告は出す。書けないだけで黙るより、うるさい方へ倒す）
mkdir -p "$(dirname "$MARKER_FILE")" 2>/dev/null || true
tmp="$(mktemp 2>/dev/null || true)"
if [ -n "$tmp" ]; then
  if jq -n --arg sid "$SESSION_ID" '{sessionId: $sid}' > "$tmp" 2>/dev/null; then
    mv "$tmp" "$MARKER_FILE" 2>/dev/null || rm -f "$tmp"
  else
    rm -f "$tmp"
  fi
fi

jq -n --arg msg "$MSG" '{ systemMessage: $msg }'
