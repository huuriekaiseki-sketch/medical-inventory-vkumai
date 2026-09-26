#!/usr/bin/env bash
set -euo pipefail

# SessionStart hook（Claude Code / Codex 共有）。
#
# WHY: 「Claude Code用worktree/ブランチとCodex用worktree/codex/*ブランチを分離し、
# 同一worktreeで並行作業しない」ルール（docs/agents/parallel-agent-work.md）は
# 自然言語のみで強制力が無い（issue #339の第3層）。プロセスレベルの同時実行検知は
# 確実な手段が無いため、部分検知として「ブランチ命名規約との取り違え」をセッション開始時に
# 機械警告する: codex/* ブランチはCodex専用、claude/* ブランチはClaude Code専用。
# 逆のツールで開いた場合に警告する（block不可・warning-only。
# docs/agents/actuator-inventory.md 的分類は warning-only）。
#
# 引数1: 起動元ツール名（"claude" / "codex"）。各ツールのhook設定側で自ツール名を渡す
# （.claude/settings.json は claude、.codex/hooks.json は codex）。
# 引数なし・未知の値の場合は判定不能として静かに終了する（誤警告しない）。
#
# どちらのプレフィックスでもない一般ブランチ（feature/* 等）は所有が確定しないため
# 警告しない（誤検知ゼロを優先する控えめ設計）。

# WHY: 警告専用（ブロックしない）hookのため、jq不在時は静かにexit 0する
# （check-branch-pr-status.shと同方針。実害は警告が出ないだけのfail-open）。
command -v jq >/dev/null 2>&1 || exit 0

TOOL="${1:-}"
case "$TOOL" in
  claude|codex) ;;
  *) exit 0 ;;
esac

BRANCH="$(git branch --show-current 2>/dev/null || true)"
[ -z "$BRANCH" ] && exit 0

OTHER=""
if [ "$TOOL" = "claude" ] && [[ "$BRANCH" == codex/* ]]; then
  OTHER="Codex"
elif [ "$TOOL" = "codex" ] && [[ "$BRANCH" == claude/* ]]; then
  OTHER="Claude Code"
fi

[ -z "$OTHER" ] && exit 0

MSG="現在のブランチ「${BRANCH}」は命名規約上 ${OTHER} 用のブランチです。Claude CodeとCodexを同じ物理worktree・ブランチで同時に動かすと、編集・ステージング・migration番号・開発サーバー等が競合します。このworktreeが${OTHER}の作業中でないか確認し、自分のツール用のworktree/ブランチへ移動してから作業してください（docs/agents/parallel-agent-work.md参照）。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
