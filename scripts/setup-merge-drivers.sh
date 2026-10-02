#!/usr/bin/env bash
set -euo pipefail

# WHY: `.gitattributes` は「どのファイルにどのドライバを使うか」しか配れず、
#      **ドライバの中身（コマンド）は各 clone の設定にしか置けない**（git の仕様）。
#      設定していない clone では `merge=jsonunion` が既定の行マージに落ちるだけで、
#      **何も言わずに衝突が増える**。だから 1 コマンドで設定できるようにした。
#      設定の形は scripts/setup-merge-drivers.test.sh が検査する
#      （以前のコメントは scripts/check-merge-drivers.test.sh が検査すると書いていたが、そのファイルは存在しなかった）。
#
# WHY(相対パス、2026-10-02): 以前は実行した場所の絶対パス（`node '/…/worktrees/<名前>/scripts/lib/…'`）を
#      書き込んでいた。しかし git の設定（.git/config）は**全 worktree で共有**される。どこかの worktree で
#      これを実行し、その worktree を消すと、**全員のドライバーが起動に失敗する**——失敗したドライバーは
#      衝突として扱われ、ファイルは自分の側のまま残る（2026-10-02、PR #882 のマージで実際に踏んだ）。
#      git はマージドライバーを**その worktree の一番上**で起動する（サブディレクトリから・別 worktree から
#      マージしても同じ。同日に一時リポジトリで実測）ので、相対パスにすれば各 worktree が自分のスクリプトを使う。
#
# 使い方: bash scripts/setup-merge-drivers.sh
#         （clone を作ったら 1 回。設定は全 worktree で共有されるので worktree ごとには要らない。冪等）

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

git config merge.jsonunion.name "JSON を構造で 3 者マージする（scripts/lib/json-union-merge.mjs）"
git config merge.jsonunion.driver "node scripts/lib/json-union-merge.mjs %O %A %B %P"

echo "設定しました:"
echo "  merge.jsonunion.driver = $(git config merge.jsonunion.driver)"
echo ""
echo "対象は .gitattributes の merge=jsonunion 行:"
grep -n 'merge=jsonunion' .gitattributes || echo "  （まだ 1 行も無い）"
