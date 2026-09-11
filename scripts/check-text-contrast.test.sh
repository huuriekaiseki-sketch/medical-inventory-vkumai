#!/usr/bin/env bash
# WHY: issue #757 の 20（画面の質）。2026-09-07 の初回計測で、ブランド色のオレンジ #FF5F03 が
#      小さい文字に使われ、画面の地色 #edeade でのコントラスト比が 2.6（WCAG AA は 4.5 を要求）だった。
#      6 画面・32 箇所。人が決めて #B03F00（比 4.90）へ変えたが、**次に画面を作る人が
#      同じ色をまた文字に使う**のを止めないと、同じことが起きる。
#
# WHY(2026-09-08 に対象を広げた): 残していた「判断待ちの 3 配色」を人が「直す」と決めたので、
#      3 つとも置き換えた。置き換えた色が戻ってこないよう、止める対象もここで広げる。
#
#        白文字 on #FF5F03（比 3.04）→ 地色を #B03F00 へ（白文字との比 5.90）
#        #6B7280 on 地色 #edeade（比 4.01）→ #4B5563 へ（比 6.27）
#        #9CA3AF on 白（比 2.53）→ #6B7280 へ（比 4.83）
#
#      **#FF5F03 は文字色としても地色としても使わない。** このリポジトリでこの色の上に乗るのは
#      必ず白文字で（ボタン・バッジ 12 箇所すべてがそうだった）、地色として置いた時点で
#      白文字との比が 3.04 になる。罫線・アイコンのように文字が乗らない用途で使いたくなったら、
#      **そのときに「上に何が乗るか」を決めてから**この検査を緩める。
#
#      **#6B7280 は禁止しない。** 白地の補足文としては比 4.83 で足りている（#9CA3AF の置き換え先）。
#      地色 #edeade の上では足りないが、それは静的には見分けられないので E2E の実測に任せる。
#
#   (a) src/ に文字色としての #FF5F03 が 1 つも無い
#   (b) src/ に地色としての #FF5F03 が 1 つも無い（上に乗るのは必ず白文字だった）
#   (c) src/ に文字色としての #9CA3AF が 1 つも無い（白地でも 2.53）
#   (d) 文字色として使ってよい濃い色（#B03F00）が実際に使われている（置き換えが消えていない）
#   (e) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 実測の正本は `e2e/a11y.spec.ts`（axe が実際の描画から比を計算する）。ここは**速い前置き**で、
#      E2E を回さなくても書いた瞬間に気づけるようにするためのもの。
#
# 実行: bash scripts/check-text-contrast.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC="$REPO_ROOT/src"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

scan_text_color() { grep -rn "color: '#FF5F03'" "$1" 2>/dev/null; }
scan_background() { grep -rn "backgroundColor: '#FF5F03'" "$1" 2>/dev/null; }
scan_light_gray() { grep -rn "color: '#9CA3AF'" "$1" 2>/dev/null; }

echo "=== scenario 1: 走査対象がある（fail-open 防止） ==="
COUNT="$(find "$SRC" -name '*.tsx' -type f 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -lt 10 ]; then
  assert_fail "走査対象の画面ファイルが少なすぎる（$COUNT 件）。走査が壊れている疑い"
else
  assert_ok "$COUNT 件の画面ファイルを走査する"
fi

echo "=== scenario 2: ブランド色を文字色に使っていない ==="
FOUND="$(scan_text_color "$SRC")"
if [ -z "$FOUND" ]; then
  assert_ok "文字色としての #FF5F03 は 0 件"
else
  assert_fail "地色 #edeade で比 2.6 の色を文字に使っている（AA は 4.5）" "$FOUND
      文字には #B03F00（比 4.90）を使う"
fi

echo "=== scenario 3: ブランド色を地色に使っていない（上に乗るのは白文字） ==="
FOUND="$(scan_background "$SRC")"
if [ -z "$FOUND" ]; then
  assert_ok "地色としての #FF5F03 は 0 件"
else
  assert_fail "白文字との比が 3.04 になる地色を使っている（AA は 4.5）" "$FOUND
      ボタン・バッジの地色には #B03F00（白文字との比 5.90）を使う"
fi

echo "=== scenario 4: 薄すぎる灰色を文字色に使っていない ==="
FOUND="$(scan_light_gray "$SRC")"
if [ -z "$FOUND" ]; then
  assert_ok "文字色としての #9CA3AF は 0 件"
else
  assert_fail "白地でも比 2.53 の灰色を文字に使っている（AA は 4.5）" "$FOUND
      補足文には #6B7280（白地で比 4.83）、本文には #4B5563（地色で比 6.27）を使う"
fi

echo "=== scenario 5: 置き換えた濃い色が実際に使われている ==="
DARK="$(grep -rln "color: '#B03F00'" "$SRC" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$DARK" -ge 10 ]; then
  assert_ok "$DARK 件のファイルが濃い色を使っている"
else
  assert_fail "濃い色の使用が $DARK 件しかない（置き換えが巻き戻った疑い）"
fi

BODY="$(grep -rln "color: '#4B5563'" "$SRC" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$BODY" -ge 10 ]; then
  assert_ok "$BODY 件のファイルが本文の濃い灰色を使っている"
else
  assert_fail "本文の濃い灰色の使用が $BODY 件しかない（置き換えが巻き戻った疑い）"
fi

echo "=== scenario 6: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/bad-text.tsx" <<'EOF'
export const X = () => <p style={{ color: '#FF5F03' }}>見出し</p>
EOF
cat > "$WORK/bad-bg.tsx" <<'EOF'
export const W = () => <button style={{ backgroundColor: '#FF5F03' }} className="text-white">押す</button>
EOF
cat > "$WORK/bad-gray.tsx" <<'EOF'
export const V = () => <p style={{ color: '#9CA3AF' }}>補足</p>
EOF
cat > "$WORK/good.tsx" <<'EOF'
export const Y = () => <p style={{ color: '#B03F00' }}>見出し</p>
export const Z = () => <p style={{ color: '#4B5563' }}>本文</p>
export const U = () => <p style={{ color: '#6B7280' }}>補足</p>
export const T = () => <button style={{ backgroundColor: '#9CA3AF' }} disabled>無効</button>
EOF

OUT="$(scan_text_color "$WORK")"
if grep -q 'bad-text.tsx' <<<"$OUT"; then assert_ok "文字色の違反を検知"; else assert_fail "文字色の違反を検知できない" "$OUT"; fi
if grep -q 'good.tsx' <<<"$OUT"; then assert_fail "正しい色を違反にした" "$OUT"; else assert_ok "文字色: 誤検知しない"; fi

OUT="$(scan_background "$WORK")"
if grep -q 'bad-bg.tsx' <<<"$OUT"; then assert_ok "地色の違反を検知"; else assert_fail "地色の違反を検知できない" "$OUT"; fi
if grep -q 'good.tsx' <<<"$OUT"; then assert_fail "正しい地色を違反にした" "$OUT"; else assert_ok "地色: 誤検知しない"; fi

OUT="$(scan_light_gray "$WORK")"
if grep -q 'bad-gray.tsx' <<<"$OUT"; then assert_ok "薄い灰色の文字を検知"; else assert_fail "薄い灰色を検知できない" "$OUT"; fi
# WHY(無効化ボタンの地色は残す): 無効化された操作は WCAG のコントラスト要件の対象外で、
#      axe も飛ばす。文字色としての使用だけを止める。
if grep -q 'good.tsx' <<<"$OUT"; then assert_fail "無効化ボタンの地色を違反にした" "$OUT"; else assert_ok "無効化ボタンの地色は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
