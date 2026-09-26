#!/usr/bin/env bash
set -euo pipefail

# WHY: 本スクリプトは警告専用（ブロックしない）hookである。jq未インストール環境では
# jq呼び出しがexit 127でスクリプトごと死に、警告が出せなくなっていた（issue #636）。
# ブロックしないスクリプトなので実害は無音のfail-open（警告が出ないだけ）であり、
# エラーノイズだけを消す目的でjq不在時は静かにexit 0する。
command -v jq >/dev/null 2>&1 || exit 0

# issue #499: docs/agents/common.md「ブランチ運用ルール」のうち、
# 「git checkout -b の前に必ず git fetch origin main してから origin/main 起点にする」
# ルールは未検知のまま棚卸し表（issue #339）に残っていた。過去に古いローカルmain起点で
# branch作成し、直近マージPRの変更が丸ごと欠落した状態で作業が進む手戻りが実際に発生
# している。2026-07-21レビューで「ローカルmainが古いという環境状態に気づけない」ことが
# 原因であり、モデルの指示追従力では解決しない型と判定され、SessionStart hookでの
# 機械検知（check-branch-pr-status.shと同型・block不可・warningのみ）を追加した。
#
# ローカルmainの鮮度を、以下いずれかで近似判定する（fetchはこのhook自身では実行しない。
# SessionStartでのネットワークアクセス・起動遅延を避けるため。オフラインでも動作する）:
#   1. FETCH_HEADの更新時刻が既定24時間（LOCAL_MAIN_STALE_HOURSで変更可）より古い
#   2. git rev-list --count main..origin/main が1以上（ローカル追跡refベースの近似判定。
#      前回fetch時点のorigin/mainより、ローカルmainが遅れているかを見る。実際の
#      リモート最新とは限らない＝近似）
#
# worktree環境での注意（過去の落とし穴）: worktreeでは`.git`がディレクトリではなく
# ファイルであり、FETCH_HEADの実体は`.git/worktrees/<name>/FETCH_HEAD`という
# worktree固有のパスにある（`.git/FETCH_HEAD`と決め打ちすると存在しないパスを見て
# 誤判定する）。`git rev-parse --git-path FETCH_HEAD`で実パスを解決することで対応した。

STALE_HOURS="${LOCAL_MAIN_STALE_HOURS:-24}"
if ! [[ "$STALE_HOURS" =~ ^[0-9]+$ ]]; then
  STALE_HOURS=24
fi

if ! command -v git >/dev/null 2>&1; then
  exit 0
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

FETCH_HEAD_PATH="$(git rev-parse --git-path FETCH_HEAD 2>/dev/null || true)"

STALE_FETCH="false"
AGE_HOURS=""
if [ -n "$FETCH_HEAD_PATH" ] && [ -f "$FETCH_HEAD_PATH" ]; then
  # mtime取得: macOS(BSD stat)とLinux(GNU stat)で-fオプション互換性が無いため、
  # 他スクリプト（check-blocked-issues-staleness.sh等）と同様python3経由で秒数を得る。
  MTIME_EPOCH="$(python3 -c "import os,sys; print(int(os.path.getmtime(sys.argv[1])))" "$FETCH_HEAD_PATH" 2>/dev/null || echo "")"
  if [ -n "$MTIME_EPOCH" ]; then
    NOW_EPOCH="$(date +%s)"
    AGE_HOURS=$(( (NOW_EPOCH - MTIME_EPOCH) / 3600 ))
    if [ "$AGE_HOURS" -ge "$STALE_HOURS" ]; then
      STALE_FETCH="true"
    fi
  fi
else
  # FETCH_HEADが無い＝このworktreeで一度もfetchしていない可能性が高いため古いとみなす。
  STALE_FETCH="true"
fi

BEHIND_COUNT="$(git rev-list --count main..origin/main 2>/dev/null || echo 0)"
if ! [[ "$BEHIND_COUNT" =~ ^[0-9]+$ ]]; then
  BEHIND_COUNT=0
fi

if [ "$STALE_FETCH" = "false" ] && [ "$BEHIND_COUNT" = "0" ]; then
  exit 0
fi

if [ -n "$AGE_HOURS" ]; then
  FETCH_DETAIL="前回fetchから約${AGE_HOURS}時間経過（既定${STALE_HOURS}時間）"
else
  FETCH_DETAIL="このworktreeでのfetch記録が見つかりません"
fi

MSG="ローカルmainが古い可能性があります（${FETCH_DETAIL}、ローカルmainはorigin/mainより${BEHIND_COUNT}コミット遅れています）。新しいブランチを作成する前に \`git fetch origin main\` してから \`git checkout -b <new-branch> origin/main\` してください（docs/agents/common.md「ブランチ運用ルール」参照）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
