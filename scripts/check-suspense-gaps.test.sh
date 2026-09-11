#!/usr/bin/env bash
# WHY(2026-09-10、壊して確かめたら防御が無かった):
#      `useSearchParams()` を呼ぶ client component は `<Suspense>` の内側に無いと
#      本番で読み込み中の状態を扱えない。Next.js の公式文書は
#      「静的ページなら**ビルドが落ちる**」と書いている。
#
#      **ところがこのリポジトリでは落ちない。** 2026-09-10 に実測:
#      Suspense 無しのページを置いて `npm run build` を回したら**成功した**（終了コード 0）。
#      このアプリは全ルートが `ƒ (Dynamic) server-rendered on demand` で、
#      静的ページが 1 つも無いため、公式の防御が**最初から適用されない**。
#
#      同じ日、Sweep（LLM）もこの欠陥を外している（sweep-ui の case-2、囮のあとの本命）。
#      **フレームワークにも LLM にも頼れないので、ここで機械的に見る。**
#
#      固定するのは 4 つ:
#        (a) 実コードに違反が無い（ratchet を 0 で張る）
#        (b) **仕込んだ欠陥で本当に落ちる**（eval の fixture をそのまま入力に使う）
#        (c) 別ファイルで包む正しい形を落とさない（対照）
#        (d) 走査が空振りしたら合格にしない（fail-open 防止）
#
# 実行: bash scripts/check-suspense-gaps.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を導入先だと思い込み、導入先の src を一度も見ないまま落ちる（E-086）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
SCAN="$SCRIPT_DIR/lib/scan-suspense-gaps.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

run_scan() { # $1 = src ルート, $2... = 追加の環境
  SCAN_OUT="$(SUSPENSE_SCAN_SRC="$1" SUSPENSE_SCAN_ALLOW_ZERO="${ALLOW_ZERO:-}" node "$SCAN" 2>&1)"
  SCAN_CODE=$?
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実コードに違反が無い（ratchet 0） ==="
run_scan "$REPO_ROOT/src"
if [ "$SCAN_CODE" -eq 0 ]; then ok "違反 0 件"; else ng "実コードで違反が出た" "$SCAN_OUT"; fi
if grep -q "useSearchParams-callers=[1-9]" <<<"$SCAN_OUT"; then
  ok "useSearchParams を呼ぶファイルを実際に数えている（空振りでない）"
else
  ng "対象を 1 件も数えていない（走査が壊れている疑い）" "$SCAN_OUT"
fi

echo "=== scenario 2: eval の fixture（仕込んだ欠陥）で本当に落ちる ==="
# WHY(fixture をそのまま入力に使う): 検査と eval が**同じ欠陥**を見ていることを固定する
for fx in \
  "scripts/eval-fixtures/sweep-ui/case-1-missing-suspense" \
  "scripts/eval-fixtures/sweep-ui/case-2-late-suspense-after-decoy"
do
  dir="$REPO_ROOT/$fx/files/src"
  if [ ! -d "$dir" ]; then ng "fixture が無い: $fx"; continue; fi
  run_scan "$dir"
  if [ "$SCAN_CODE" -ne 0 ] && grep -q "suspense-gap" <<<"$SCAN_OUT"; then
    ok "$(basename "$fx") を検知"
  else
    ng "$(basename "$fx") を検知できない（rc=${SCAN_CODE}）" "$SCAN_OUT"
  fi
done

echo "=== scenario 3: 別ファイルで包む正しい形は落とさない（対照） ==="
# WHY: 陰性対照はページ側で <Suspense> に入れている。**同じファイルだけを見る規則では誤検知する**
dir="$REPO_ROOT/scripts/eval-fixtures/sweep-ui/case-3-negative-control/files/src"
run_scan "$dir"
if [ "$SCAN_CODE" -eq 0 ]; then ok "import 元が包んでいれば違反にしない"; else ng "正しい形を落とした" "$SCAN_OUT"; fi

echo "=== scenario 4: 同じファイルに Suspense があれば通る（このリポジトリの形） ==="
mkdir -p "$WORK/same/app"
cat > "$WORK/same/app/page.tsx" <<'TSX'
'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
function Inner() {
  const sp = useSearchParams()
  return <p>{sp.get('q')}</p>
}
export default function Page() {
  return <Suspense fallback={<p>...</p>}><Inner /></Suspense>
}
TSX
run_scan "$WORK/same"
if [ "$SCAN_CODE" -eq 0 ]; then ok "同ファイルの Suspense で通る"; else ng "同ファイルの形を落とした" "$SCAN_OUT"; fi

echo "=== scenario 5: 包んでいない import 元しか無ければ落ちる ==="
# WHY: 「import 元に <Suspense> という語がある」だけで通すと、**別の場所の Suspense**で
#      通ってしまう。使っている場所が内側かどうかまで見る
mkdir -p "$WORK/outside/components" "$WORK/outside/app"
cat > "$WORK/outside/components/filter.tsx" <<'TSX'
'use client'
import { useSearchParams } from 'next/navigation'
export function Filter() {
  const sp = useSearchParams()
  return <p>{sp.get('q')}</p>
}
TSX
cat > "$WORK/outside/app/page.tsx" <<'TSX'
import { Suspense } from 'react'
import { Filter } from '../components/filter'
function Other() { return <p>other</p> }
export default function Page() {
  return (
    <div>
      <Suspense fallback={<p>...</p>}><Other /></Suspense>
      <Filter />
    </div>
  )
}
TSX
run_scan "$WORK/outside"
if [ "$SCAN_CODE" -ne 0 ]; then ok "Suspense の外で使っていれば落ちる"; else ng "外側の使用を見逃した" "$SCAN_OUT"; fi

# 対照: 同じ構成で Suspense の内側へ移せば通る
cat > "$WORK/outside/app/page.tsx" <<'TSX'
import { Suspense } from 'react'
import { Filter } from '../components/filter'
export default function Page() {
  return <Suspense fallback={<p>...</p>}><Filter /></Suspense>
}
TSX
run_scan "$WORK/outside"
if [ "$SCAN_CODE" -eq 0 ]; then ok "内側へ移せば通る（対照）"; else ng "正しい形を落とした" "$SCAN_OUT"; fi

echo "=== scenario 6: 逃がす印は理由が要る ==="
mkdir -p "$WORK/exempt/app"
cat > "$WORK/exempt/app/page.tsx" <<'TSX'
'use client'
// suspense-exempt:
import { useSearchParams } from 'next/navigation'
export default function Page() {
  const sp = useSearchParams()
  return <p>{sp.get('q')}</p>
}
TSX
run_scan "$WORK/exempt"
if [ "$SCAN_CODE" -ne 0 ]; then ok "理由の無い印では逃がさない"; else ng "空の理由で通した" "$SCAN_OUT"; fi
cat > "$WORK/exempt/app/page.tsx" <<'TSX'
'use client'
// suspense-exempt: この画面は常に動的レンダリングで、初期 HTML を作らないため
import { useSearchParams } from 'next/navigation'
export default function Page() {
  const sp = useSearchParams()
  return <p>{sp.get('q')}</p>
}
TSX
run_scan "$WORK/exempt"
if [ "$SCAN_CODE" -eq 0 ]; then ok "理由を書けば逃がす（対照）"; else ng "理由付きでも通らない" "$SCAN_OUT"; fi

echo "=== scenario 7: 走査が空振りしたら合格にしない（fail-open 防止） ==="
mkdir -p "$WORK/empty"
run_scan "$WORK/empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "ファイル 0 件なら落とす"; else ng "空でも合格にした" "$SCAN_OUT"; fi

mkdir -p "$WORK/nocaller/app"
printf 'export default function Page() { return <p>x</p> }\n' > "$WORK/nocaller/app/page.tsx"
run_scan "$WORK/nocaller"
if [ "$SCAN_CODE" -ne 0 ] && grep -q "1 つも無い" <<<"$SCAN_OUT"; then
  ok "useSearchParams が 0 件なら走査の壊れを疑う"
else
  ng "0 件を黙って合格にした（rc=${SCAN_CODE}）" "$SCAN_OUT"
fi
ALLOW_ZERO=1 run_scan "$WORK/nocaller"
if [ "$SCAN_CODE" -eq 0 ]; then ok "本当に 0 件なら逃がし口がある（対照）"; else ng "逃がし口が効かない" "$SCAN_OUT"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
