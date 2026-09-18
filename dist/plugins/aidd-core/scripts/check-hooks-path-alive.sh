#!/usr/bin/env bash
set -euo pipefail

# WHY: issue #779（E-092 の再発）。git は **存在しない core.hooksPath を黙って無視する**。
#      エラーも警告も出さないので、hook が 1 つも動かない状態に誰も気づけない。
#
#      実害（2026-09-13 と 2026-09-18 の 2 回、同じ worktree で発生）:
#        - ある worktree の `config.worktree` に、**メイン checkout の絶対パス**を指す
#          `core.hooksPath` が入っていた（そのブランチにそのディレクトリは無い）
#        - `extensions.worktreeConfig` が有効なので、worktree スコープが clone の設定に勝つ
#        - その worktree では commit-msg も pre-push も**一度も動かず**、
#          2026-09-18 には CI 修正 4 件がハーネス凍結（H-014）を素通りした
#
#      2026-09-13 に発見して手順（`git config --show-scope --get-all core.hooksPath` を打つ）を
#      文書に書いたが、**人が毎回打つ手順は書いてあっても実行されない**ので 5 日後に再発した。
#      docs/agents/check-design-pitfalls.md の「検知を賢くするより、間違えられる道を無くす」。
#
# **この検知を git hook で実装してはいけない**（設計上の要点）:
#      検知したい故障が「git hook が動かない」なので、同じ経路に乗せると一緒に死ぬ。
#      Claude Code の SessionStart hook は .claude/settings.json で設定され、
#      git の core.hooksPath とは独立に動くので、ここなら検知できる。
#
# 見るもの:
#   (a) effective な core.hooksPath が指す先が、実在するディレクトリか
#   (b) worktree スコープの上書きが在るか（相対の local 設定で足りるので、基本は不要）
#
# 見ないもの（限界）:
#   - hook ファイルの中身・実行ビット（`scripts/check-git-hooks.test.sh` の担当）
#   - hooksPath が未設定のまま既定（.git/hooks）を使っている環境。そこに hook を置く運用も
#     ありうるため「設定が無い」だけでは警告しない
#
# 警告のみ（block しない）。SessionStart hook は止める手段を持たないうえ、
# この検査自体が壊れて全員の作業を止める方が害が大きい。

command -v jq >/dev/null 2>&1 || exit 0
command -v git >/dev/null 2>&1 || exit 0
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0

# effective な値（最も優先度の高いスコープの 1 つ）
EFFECTIVE="$(git config --get core.hooksPath 2>/dev/null || true)"

# worktree スコープに上書きが在るか。--show-scope は scope<TAB>value で出る
WORKTREE_OVERRIDE=""
while IFS=$'\t' read -r scope value; do
  if [ "$scope" = "worktree" ]; then
    WORKTREE_OVERRIDE="$value"
  fi
done < <(git config --show-scope --get-all core.hooksPath 2>/dev/null || true)

# 設定そのものが無ければ既定（.git/hooks）を使う運用とみなし、何も言わない
if [ -z "$EFFECTIVE" ]; then
  exit 0
fi

# 相対パスは「作業ツリーの最上位から」解決される
TOPLEVEL="$(git rev-parse --show-toplevel 2>/dev/null || echo ".")"
case "$EFFECTIVE" in
  /*) RESOLVED="$EFFECTIVE" ;;
  *)  RESOLVED="$TOPLEVEL/$EFFECTIVE" ;;
esac

PROBLEMS=()
if [ ! -d "$RESOLVED" ]; then
  PROBLEMS+=("core.hooksPath が指す \`$EFFECTIVE\` が存在しません（解決先: \`$RESOLVED\`）。**git はこれを黙って無視するため、commit-msg も pre-push も動いていません**")
fi
if [ -n "$WORKTREE_OVERRIDE" ]; then
  PROBLEMS+=("worktree スコープの上書き \`$WORKTREE_OVERRIDE\` があります（clone の相対設定に勝ちます）。意図が無ければ \`git config --worktree --unset core.hooksPath\` で外してください")
fi

if [ ${#PROBLEMS[@]} -eq 0 ]; then
  exit 0
fi

DETAIL=""
for p in "${PROBLEMS[@]}"; do
  DETAIL="${DETAIL}- ${p}
"
done

MSG="git hook が動いていない可能性があります（E-092）。
${DETAIL}確認: \`git config --show-scope --get-all core.hooksPath\`
入れ直し: このリポジトリの hook 導入手順（\`core.hooksPath\` は**相対**で向ける。絶対パスは worktree で壊れる）
これを見逃すと、commit-msg・pre-push に載せた守りが**すべて無音で素通り**します。"

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext: $msg
  }
}'
