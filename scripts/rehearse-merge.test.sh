#!/usr/bin/env bash
# WHY: rehearse-merge は「作業ツリーを触らない」ことが前提の道具なので、そこを固定する。
#      触ってしまうと、溜まったブランチを調べたつもりで作業中の変更を壊す。
#
#   (a) 衝突しない 2 本は OK と報告する
#   (b) 同じ行を変える 2 本は衝突として報告し、ファイル名を出す
#   (c) 衝突があれば終了コード 1（CI で使える）
#   (d) 実行しても作業ツリー・現在のブランチ・HEAD が変わらない
#   (e) 無いブランチは「無し」として飛ばす（マージ済みのブランチを消しても動く）
#   (f) 起点が実際に積む先より遅れていたら、合否を出さずに止まる（2026-09-10）
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
if [ "$RC" -eq 0 ] && grep -q 'OK      feat/a' <<<"$OUT" && grep -q 'OK      feat/c' <<<"$OUT"; then
  assert_ok "2 本とも OK・終了コード 0"
else
  assert_fail "衝突しない組を OK と報告しない（rc=${RC}）" "$OUT"
fi

echo "=== scenario 2: 同じ行を変える 2 本は衝突 ==="
OUT="$(node "$ENGINE" --repo "$FX" --base main --branches feat/a,feat/b 2>&1)"
RC=$?
if [ "$RC" -eq 1 ] && grep -q '衝突    feat/b' <<<"$OUT"; then
  assert_ok "衝突を検知・終了コード 1"
else
  assert_fail "衝突を検知できない（rc=${RC}）" "$OUT"
fi
if grep -q 'shared.md' <<<"$OUT"; then
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
if grep -q '無し    feat/gone' <<<"$OUT"; then
  assert_ok "無いブランチを「無し」と報告"
else
  assert_fail "無いブランチで落ちる" "$OUT"
fi

echo "=== scenario 5: 実態の順番ファイルで動く ==="
# WHY(2026-09-10): 以前は `"conflictCount"` が出ることだけを見ていた。
#      いまは起点が遅れていれば合否を出さずに止まる（scenario 6）ので、
#      **どちらの答え方でも「答えている」ことを確かめる**形にする。
#      実リポジトリの起点の進み具合に依存しない（依存させると、GitHub 復旧の前後で結果が変わる）。
OUT="$(bash "$SCRIPT_DIR/rehearse-merge.sh" --json 2>&1)"
if grep -q '"conflictCount"' <<<"$OUT" || grep -q '"staleBase"' <<<"$OUT"; then
  assert_ok "順番ファイルを読んで、合否か「判定できない」かのどちらかを機械可読で出す"
else
  assert_fail "順番ファイルで動かない" "$(head -5 <<<"$OUT")"
fi

echo "=== scenario 6: 起点が遅れていたら、合否を出さずに止まる ==="
# WHY(2026-09-10 実測): 既定の起点 origin/main は GitHub のアカウント停止で 9/6 から凍っており、
#      実際に積む先の main は 246 コミット進んでいた。その起点で回すと
#      **実在しない衝突 10 件**が出た（実際の main を起点にすると 37 本すべて「済み」で 0 件）。
#      これは「衝突している」でも「していない」でもなく**誰も聞いていない問いへの答え**なので、
#      合否（0/1）に混ぜず 3 で止める（C-025: 別々の状態を 1 つに潰さない）。
FX2="$WORK/repo2"
mkdir -p "$FX2"
git -C "$FX2" init -q
git -C "$FX2" config user.email "test@example.test"
git -C "$FX2" config user.name "test"
printf 'base\n' > "$FX2/f.md"
git -C "$FX2" add -A
git -C "$FX2" commit -qm base
git -C "$FX2" branch -M main
git -C "$FX2" branch frozen            # 凍った起点（origin/main の代役）
git -C "$FX2" checkout -q -b feat/x
printf 'x\n' > "$FX2/x.md"
git -C "$FX2" add -A
git -C "$FX2" commit -qm x
git -C "$FX2" checkout -q main
printf 'moved\n' > "$FX2/f.md"        # main だけが進む
git -C "$FX2" commit -qam moved

OUT="$(node "$ENGINE" --repo "$FX2" --base frozen --branches feat/x 2>&1)"
RC=$?
if [ "$RC" -eq 3 ]; then
  assert_ok "遅れた起点では終了コード 3（合否の 0/1 と混ぜない）"
else
  assert_fail "遅れた起点でも合否を出してしまう（rc=${RC}）" "$OUT"
fi
if grep -q '起点が遅れています' <<<"$OUT"; then
  assert_ok "何が起きたかを言う"
else
  assert_fail "理由を言わない" "$OUT"
fi
if grep -q -- '--base main' <<<"$OUT"; then
  assert_ok "どうすればよいかを言う"
else
  assert_fail "直し方を言わない" "$OUT"
fi

# 対照: 実際に積む先を起点にすれば、ふつうに合否が出る
OUT="$(node "$ENGINE" --repo "$FX2" --base main --branches feat/x 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'OK      feat/x' <<<"$OUT"; then
  assert_ok "実際に積む先を起点にすれば合否が出る（対照）"
else
  assert_fail "正しい起点でも動かない（rc=${RC}）" "$OUT"
fi

# 対照: 敢えて遅れた起点で測る逃げ道は残す
OUT="$(node "$ENGINE" --repo "$FX2" --base frozen --branches feat/x --allow-stale-base 2>&1)"
RC=$?
if [ "$RC" -eq 0 ] && grep -q 'OK      feat/x' <<<"$OUT"; then
  assert_ok "--allow-stale-base なら測れる（対照）"
else
  assert_fail "逃げ道が効かない（rc=${RC}）" "$OUT"
fi

# 機械可読でも「測っていない」と言う
OUT="$(node "$ENGINE" --repo "$FX2" --base frozen --branches feat/x --json 2>&1)"
if grep -q '"measured": false' <<<"$OUT"; then
  assert_ok "JSON でも測っていないと言う（0 件と言わない）"
else
  assert_fail "JSON が測ったように見える" "$OUT"
fi

echo "=== scenario 7: 順番が空なら「合格」と読まない（走査の空振り） ==="
# WHY(C-021): 空のまま進むと「衝突 0 件 / 0 本」で終了コード 0 になり、
#      **測る対象が無いこと**が**調べて問題が無かったこと**に見える。
printf '{"queue":[]}\n' > "$WORK/empty-queue.json"
OUT="$(node "$ENGINE" --repo "$FX" --base main --queue "$WORK/empty-queue.json" 2>&1)"
RC=$?
if [ "$RC" -ne 0 ]; then
  assert_ok "空の順番では合格にしない（rc=${RC}）"
else
  assert_fail "空の順番を合格として通した" "$OUT"
fi
if grep -q '測る対象が 1 本も無い' <<<"$OUT"; then
  assert_ok "空であることを名指しする"
else
  assert_fail "空だと言わない" "$OUT"
fi

# 対照: 1 本でもあれば、ふつうに通る
printf '{"queue":[{"label":"a","branch":"feat/a"}]}\n' > "$WORK/one-queue.json"
OUT="$(node "$ENGINE" --repo "$FX" --base main --queue "$WORK/one-queue.json" 2>&1)"
RC=$?
if [ "$RC" -eq 0 ]; then
  assert_ok "1 本あれば通る（対照）"
else
  assert_fail "1 本でも落ちる（rc=${RC}）" "$OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
