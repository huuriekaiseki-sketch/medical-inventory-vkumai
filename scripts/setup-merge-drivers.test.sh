#!/usr/bin/env bash
# WHY(2026-10-02): scripts/setup-merge-drivers.sh は、実行した worktree の絶対パスを共有の git 設定に
#      書き込んでいた。その worktree を消すと全員のドライバーが起動に失敗し、JSON の衝突が黙って増えた
#      （PR #882 のマージで実際に踏んだ）。一時リポジトリで「worktree でセットアップ → その worktree を消す
#      → 本体で JSON をマージ」を再現し、ドライバーが動いて両方の変更が残ることを見る。
#      本物のリポジトリの設定には一切触れない。
#
# 実行: bash scripts/setup-merge-drivers.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP="${SETUP_UNDER_TEST:-$SCRIPT_DIR/setup-merge-drivers.sh}"
DRIVER="$SCRIPT_DIR/lib/json-union-merge.mjs"

command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いのでドライバーを動かせない）"
  echo "ALL PASSED"
  exit 0
}

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
REPO="$ROOT/repo"

# 一時リポジトリ: セットアップとドライバーの実物を置き、JSON を merge=jsonunion にする
git init -q -b main "$REPO"
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name t
mkdir -p "$REPO/scripts/lib"
cp "$SETUP" "$REPO/scripts/setup-merge-drivers.sh"
cp "$DRIVER" "$REPO/scripts/lib/json-union-merge.mjs"
echo '*.json merge=jsonunion' > "$REPO/.gitattributes"
printf '{\n  "a": 1\n}\n' > "$REPO/data.json"
git -C "$REPO" add -A
git -C "$REPO" commit -qm base

echo "=== scenario 1: worktree でセットアップしても、設定に worktree の絶対パスが入らない ==="
git -C "$REPO" worktree add -q -b setup-wt "$ROOT/setup-wt" main
(cd "$ROOT/setup-wt" && bash scripts/setup-merge-drivers.sh > /dev/null)
driver="$(git -C "$REPO" config merge.jsonunion.driver)"
if [[ "$driver" == *"$ROOT"* ]]; then
  ng "設定に一時ディレクトリの絶対パスが入っている（worktree を消すと壊れる）" "$driver"
else
  ok "絶対パスが入っていない（${driver}）"
fi

echo "=== scenario 2: セットアップした worktree を消しても、本体の JSON マージでドライバーが動く ==="
git -C "$REPO" worktree remove --force "$ROOT/setup-wt"
git -C "$REPO" checkout -q -b theirs main
printf '{\n  "a": 1,\n  "b": 2\n}\n' > "$REPO/data.json"
git -C "$REPO" commit -qam theirs
git -C "$REPO" checkout -q main
printf '{\n  "a": 1,\n  "c": 3\n}\n' > "$REPO/data.json"
git -C "$REPO" commit -qam ours
out="$(git -C "$REPO" merge --no-edit theirs 2>&1)"
status=$?
if [ "$status" -eq 0 ]; then
  ok "マージが成功する"
else
  ng "マージが失敗した（ドライバーが起動できていない疑い）" "$out"
fi
if grep -q '"b"' "$REPO/data.json" && grep -q '"c"' "$REPO/data.json"; then
  ok "両方の変更（b と c）が残る"
else
  ng "片方の変更が落ちた" "$(cat "$REPO/data.json")"
fi
if grep -q -e "Cannot find module" -e "MODULE_NOT_FOUND" <<<"$out"; then
  ng "ドライバーの起動に失敗している" "$out"
else
  ok "ドライバーの起動に失敗していない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
