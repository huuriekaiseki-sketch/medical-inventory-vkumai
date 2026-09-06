#!/usr/bin/env bash
# WHY: rehearse-merge は「作業ツリーを触らない」ことが前提の道具なので、そこを固定する。
#      触ってしまうと、溜まったブランチを調べたつもりで作業中の変更を壊す。
#
#   (a) 衝突しない 2 本は OK と報告する
#   (b) 同じ行を変える 2 本は衝突として報告し、ファイル名を出す
#   (c) 衝突があれば終了コード 1（CI で使える）
#   (d) 実行しても作業ツリー・現在のブランチ・HEAD が変わらない
#   (e) 無いブランチは「無し」として飛ばす（マージ済みのブランチを消しても動く）
#
# 実行: bash scripts/rehearse-merge.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENGINE="$SCRIPT_DIR/lib/rehearse-merge.mjs"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# fixture のミニリポジトリを作る
FX="$WORK/repo"
mkdir -p "$FX"
git -C "$FX" init -q
git -C "$FX" config user.email "test@example.test"
git -C "$FX" config user.name "test"
printf 'line1\nline2\nline3\n' > "$FX/shared.md"
printf 'base\n' > "$FX/other.md"
git -C "$FX" add -A
git -C "$FX" commit -qm base
git -C "$FX" branch -M main

git -C "$FX" checkout -q -b feat/a
printf 'line1\nCHANGED-BY-A\nline3\n' > "$FX/shared.md"
git -C "$FX" commit -qam a

git -C "$FX" checkout -q main
git -C "$FX" checkout -q -b feat/b
printf 'line1\nCHANGED-BY-B\nline3\n' > "$FX/shared.md"
git -C "$FX" commit -qam b

git -C "$FX" checkout -q main
git -C "$FX" checkout -q -b feat/c
printf 'independent\n' > "$FX/other.md"
git -C "$FX" commit -qam c

git -C "$FX" checkout -q main

echo "=== scenario 1: 衝突しない 2 本は OK ==="
OUT="$(node "$ENGINE" --repo "$FX" --base main --branches feat/a,feat/c 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] && printf '%s' "$OUT" | grep -q 'OK      feat/a' && printf '%s' "$OUT" | grep -q 'OK      feat/c'; then
  assert_ok "2 本とも OK・終了コード 0"
else
  assert_fail "衝突しない組を OK と報告しない（rc=$RC）" "$OUT"
fi

echo "=== scenario 2: 同じ行を変える 2 本は衝突 ==="
OUT="$(node "$ENGINE" --repo "$FX" --base main --branches feat/a,feat/b 2>&1)"
RC=$?
if [ "$RC" -eq 1 ] && printf '%s' "$OUT" | grep -q '衝突    feat/b'; then
  assert_ok "衝突を検知・終了コード 1"
else
  assert_fail "衝突を検知できない（rc=$RC）" "$OUT"
fi
if printf '%s' "$OUT" | grep -q 'shared.md'; then
  assert_ok "衝突したファイル名を出す"
else
  assert_fail "ファイル名を出さない" "$OUT"
fi

echo "=== scenario 3: 作業ツリー・ブランチ・HEAD が変わらない ==="
BEFORE_HEAD="$(git -C "$FX" rev-parse HEAD)"
BEFORE_BRANCH="$(git -C "$FX" branch --show-current)"
BEFORE_STATUS="$(git -C "$FX" status --porcelain)"
node "$ENGINE" --repo "$FX" --base main --branches feat/a,feat/b > /dev/null 2>&1
if [ "$(git -C "$FX" rev-parse HEAD)" = "$BEFORE_HEAD" ] \
  && [ "$(git -C "$FX" branch --show-current)" = "$BEFORE_BRANCH" ] \
  && [ "$(git -C "$FX" status --porcelain)" = "$BEFORE_STATUS" ]; then
  assert_ok "HEAD・ブランチ・作業ツリーが不変"
else
  assert_fail "予行演習がリポジトリを変えた（merge-tree / commit-tree だけを使うこと）"
fi

echo "=== scenario 4: 無いブランチは飛ばす ==="
OUT="$(node "$ENGINE" --repo "$FX" --base main --branches feat/a,feat/gone 2>&1)"
if printf '%s' "$OUT" | grep -q '無し    feat/gone'; then
  assert_ok "無いブランチを「無し」と報告"
else
  assert_fail "無いブランチで落ちる" "$OUT"
fi

echo "=== scenario 5: 実態の順番ファイルで動く ==="
OUT="$(bash "$SCRIPT_DIR/rehearse-merge.sh" --json 2>&1)"
if printf '%s' "$OUT" | grep -q '"conflictCount"'; then
  assert_ok "順番ファイルを読んで JSON を出す"
else
  assert_fail "順番ファイルで動かない" "$(printf '%s' "$OUT" | head -5)"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
