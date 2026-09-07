#!/usr/bin/env bash
set -euo pipefail

# WHY: `.gitattributes` は「どのファイルにどのドライバを使うか」しか配れず、
#      **ドライバの中身（コマンド）は各 clone の設定にしか置けない**（git の仕様）。
#      設定していない clone では `merge=jsonunion` が既定の行マージに落ちるだけで、
#      **何も言わずに衝突が増える**。だから 1 コマンドで設定できるようにして、
#      設定されているかを scripts/check-merge-drivers.test.sh が検査する。
#
# 使い方: bash scripts/setup-merge-drivers.sh
#         （clone・worktree を作ったら 1 回。冪等）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

git config merge.jsonunion.name "JSON を構造で 3 者マージする（scripts/lib/json-union-merge.mjs）"
git config merge.jsonunion.driver "node '$REPO_ROOT/scripts/lib/json-union-merge.mjs' %O %A %B %P"

echo "設定しました:"
echo "  merge.jsonunion.driver = $(git config merge.jsonunion.driver)"
echo ""
echo "対象は .gitattributes の merge=jsonunion 行:"
grep -n 'merge=jsonunion' .gitattributes || echo "  （まだ 1 行も無い）"
