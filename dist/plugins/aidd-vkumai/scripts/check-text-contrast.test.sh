#!/usr/bin/env bash
# WHY: issue #757 の 20（画面の質）。2026-09-07 の初回計測で、ブランド色のオレンジ #FF5F03 が
#      小さい文字に使われ、画面の地色 #edeade でのコントラスト比が 2.6（WCAG AA は 4.5 を要求）だった。
#      6 画面・32 箇所。人が決めて #B03F00（比 4.90）へ変えたが、**次に画面を作る人が
#      同じ色をまた文字に使う**のを止めないと、同じことが起きる。
#
#      背景色・罫線としての #FF5F03 は残してよい（文字ではないので比の対象が違う）。
#      ここで止めるのは「文字色としての使用」だけ。
#
#   (a) src/ に `color: '#FF5F03'` が 1 つも無い
#   (b) 文字色として使ってよい濃い色（#B03F00）が実際に使われている（置き換えが消えていない）
#   (c) fixture で (a) を検知できる（RED 方向の自己検証）
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

# 文字色としてブランド色を使っている行を列挙する
scan_text_color() {
  grep -rn "color: '#FF5F03'" "$1" 2>/dev/null
}

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
  assert_fail "白背景で読みにくい色を文字に使っている（地色 #edeade で AA の 4.5 未満）" "$FOUND
      文字には #B03F00（比 4.90）を使う。背景色・罫線は #FF5F03 のままでよい"
fi

echo "=== scenario 3: 置き換えた濃い色が実際に使われている ==="
DARK="$(grep -rln "color: '#B03F00'" "$SRC" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$DARK" -ge 10 ]; then
  assert_ok "$DARK 件のファイルが濃い色を使っている"
else
  assert_fail "濃い色の使用が $DARK 件しかない（置き換えが巻き戻った疑い）"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/bad.tsx" <<'EOF'
export const X = () => <p style={{ color: '#FF5F03' }}>見出し</p>
EOF
cat > "$WORK/good.tsx" <<'EOF'
export const Y = () => <p style={{ color: '#B03F00' }}>見出し</p>
export const Z = () => <div style={{ backgroundColor: '#FF5F03' }} />
EOF
OUT="$(scan_text_color "$WORK")"
if printf '%s' "$OUT" | grep -q 'bad.tsx'; then assert_ok "文字色の違反を検知"; else assert_fail "違反を検知できない" "$OUT"; fi
if printf '%s' "$OUT" | grep -q 'good.tsx'; then assert_fail "濃い色・背景色を違反にした" "$OUT"; else assert_ok "濃い色と背景色は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
