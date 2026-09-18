#!/usr/bin/env bash
# この clone に、リポジトリで管理している git hooks（scripts/git-hooks/）を入れる。
#
# WHY(2026-09-11): git の hook は clone ごとの設定で、リポジトリに入れただけでは動かない。
#      ここでは git の設定 core.hooksPath を scripts/git-hooks（相対パス）へ向けるだけにする。
#      相対パスは各 worktree の最上位から解決されるので、**worktree ごとに自分の版の hook が動く**
#      （hook のファイルを持たない古いブランチの worktree では、何も起きない）。
#      コピーではないので、hook を直せば次のコミットから効き、写しが古びることもない。
#
# 使い方:
#   bash scripts/install-git-hooks.sh              # 入れる（何度打っても同じ）
#   bash scripts/install-git-hooks.sh --uninstall  # 外す（core.hooksPath を消す）
#   bash scripts/install-git-hooks.sh --force      # .git/hooks に有効な hook があっても向ける
#
# 限界: 設定は clone ごと。新しく clone した環境では、これを打つまで hook は動かない
#       （その間の取りこぼしは hooks-test の走査が後から拾う）。
set -euo pipefail

HOOKS_REL="scripts/git-hooks"
ROOT="$(git rev-parse --show-toplevel)"
current="$(git -C "$ROOT" config --get core.hooksPath || true)"

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$current" = "$HOOKS_REL" ]; then
    git -C "$ROOT" config --unset core.hooksPath
    echo "外しました（core.hooksPath を消した）"
  else
    echo "入っていません（core.hooksPath=${current:-未設定}）"
  fi
  exit 0
fi

if [ "$current" = "$HOOKS_REL" ]; then
  echo "既に入っています（core.hooksPath=${HOOKS_REL}）"
  exit 0
fi
if [ -n "$current" ]; then
  echo "core.hooksPath が別の場所（${current}）を指しているので上書きしません。先にその持ち主に確認してください" >&2
  exit 1
fi

# core.hooksPath を向けると、.git/hooks/ の hook は**素通り**になる。有効な hook があれば止まる
common="$(git -C "$ROOT" rev-parse --path-format=absolute --git-common-dir)"
active=""
if [ -d "$common/hooks" ]; then
  for f in "$common/hooks"/*; do
    [ -f "$f" ] || continue
    case "$f" in
      *.sample) continue ;;
    esac
    if [ -x "$f" ]; then
      active="${active} $(basename "$f")"
    fi
  done
fi
if [ -n "$active" ] && [ "${1:-}" != "--force" ]; then
  echo ".git/hooks に有効な hook があります（${active# }）。core.hooksPath を向けるとそれが動かなくなるので止めます（承知なら --force）" >&2
  exit 1
fi

# git は実行ビットの無い hook を**黙って無視する**。入れた気になって動かない、を先に止める
for h in "$ROOT/$HOOKS_REL"/*; do
  [ -f "$h" ] || continue
  if [ ! -x "$h" ]; then
    echo "実行ビットが無い hook があります: ${h#"$ROOT"/}（git は黙って無視する）" >&2
    exit 1
  fi
done

git -C "$ROOT" config core.hooksPath "$HOOKS_REL"
echo "入れました: core.hooksPath=${HOOKS_REL}（この clone の worktree すべてに効く）"
