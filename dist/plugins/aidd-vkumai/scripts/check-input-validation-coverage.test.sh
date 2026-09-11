#!/usr/bin/env bash
# WHY: issue #757 の 20。2026-09-07 に zod で入口の検証を作ったが、適用できたのは 18 本中 2 本。
#      残りは借金として一覧（scripts/lib/input-validation-baseline.json）に置いた。
#      **借金そのものより、借金が静かに増えることのほうが危ない。**
#      新しい route が本文を検査せずに読んでも誰も気づかない状態を、ここで止める。
#
#      同じ形の ratchet がこのリポジトリには既にある（攻撃表・制約カバレッジ・
#      ミューテーションスコア）。「今あるものは許す。増えたら落とす。減ったら基準を下げる」。
#
#      2026-09-07 追記: 判定を「スキーマを読み込んでいるか」から「parseBody を使っているか」へ
#      変えた。読み込んだうえで使わない route を捕まえられなかったため。あわせて
#      request.json() の直接呼び出しを eslint で禁止し、移行待ちの route だけ
#      eslint-disable を付けている。**印を付ければ逃げられる**ので、印の付いた route が
#      一覧に載っていることもここで検査する。
#
#   (a) 本文を読む route はすべて、parseBody を使っているか一覧に載っている
#   (b) 一覧に載っているのに実は parseBody を使っている行は、陳腐化として落とす（消し忘れ検知）
#   (b2) eslint-disable が付いているのに一覧に載っていない route は落とす（印で逃げる穴）
#   (c) 一覧に載っているのに route が存在しない行も落とす（消し忘れ検知）
#   (d) 走査対象が少なすぎたら落とす（fail-open 防止）
#   (e) fixture で (a)(b) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-input-validation-coverage.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/src/app/api"
BASELINE="$REPO_ROOT/scripts/lib/input-validation-baseline.json"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1: api ディレクトリ, $2: baseline（省略可）
# 出力: "new <route>" / "stale-used <route>" / "stale-missing <route>"
scan() {
  node -e '
const fs = require("fs")
const path = require("path")

const apiDir = process.argv[1]
const baselinePath = process.argv[2]

const pending = new Set()
if (baselinePath && fs.existsSync(baselinePath)) {
  const b = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  for (const row of b.pending ?? []) pending.add(row.route)
}

const routes = []
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p)
    else if (entry.name === "route.ts") routes.push(p)
  }
}
walk(apiDir)

// WHY(数える単位をメソッドにする・2026-09-10、レビューの設計提案 2「複数メソッド」):
//      それまではファイル単位で数えていた。**1 つの route に POST と PUT があり、
//      POST だけ parseBody を通っていれば、PUT が生読みでもファイルとしては通る**
//      （2026-09-10 に fixture で実測。素通りした）。
//      穴が開く単位は route ファイルではなく **route × メソッド**なので、そこで数える
//      （C-031: 数える単位が、実際に壊れる単位と違う）。
//      借金の一覧（baseline）の鍵も `api/x/route.ts#PUT` の形にする——
//      ファイル単位の鍵だと、1 メソッドを免除するつもりでファイル全体が免除される。
//
//      いま実際に穴を止めているのは eslint の deny-by-default（R10）で、生の `.json()` は
//      lint が落とす。ここが数えるのは**借金の量**なので、単位が違うと量を読み違える。
/** export された HTTP メソッドごとに本体を切り出す */
const methodBodies = (code) => {
  const out = []
  const re = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(/gm
  let m
  while ((m = re.exec(code)) !== null) {
    const start = m.index
    const nextRe = /^export\s+(?:async\s+)?function\s+/gm
    nextRe.lastIndex = start + m[0].length
    const n = nextRe.exec(code)
    out.push({ method: m[1], body: code.slice(start, n ? n.index : code.length) })
  }
  return out
}

const seen = new Set()
for (const file of routes) {
  const src = fs.readFileSync(file, "utf8")
  // WHY(2026-09-07): 全 route を parseBody へ移したので request.json() の文字列は
  //      コメントにしか残らなくなった。「本文を読む」の目印を
  //      「parseBody を呼ぶ」か「.json() をコメント以外で呼ぶ」に変える
  // WHY(名前で当てるのをやめた・2026-09-10、レビュー指摘 R10): 以前は
  //      `request.json(` という**引数名を含む文字列**で見ていたので、
  //      `export async function POST(httpRequest)` のように名前を変えるだけで
  //      「本文を読む route」の一覧から静かに外れた（=検査対象にすらならない）。
  //      応答を作る NextResponse.json / Response.json だけを先に取り除き、
  //      **残った .json() はすべて本文読みとみなす**（知らない名前は対象に入る）。
  const code = src.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
  const relFile = "api/" + path.relative(apiDir, file).split(path.sep).join("/")
  for (const { method, body } of methodBodies(code)) {
    const withoutResponses = body.replace(/\b(?:NextResponse|Response)\s*\.\s*json\s*\(/g, " ")
    const usesParseBody = /parseBody\s*\(/.test(body)
    const readsBody = usesParseBody || /[A-Za-z_$][\w$]*\s*\.\s*json\s*\(/.test(withoutResponses)
    if (!readsBody) continue
    const rel = relFile + "#" + method
    seen.add(rel)
    // 印はメソッドの本体の中だけを見る（ファイルのどこかに 1 つあれば通る、にしない）
    const rawBody = src.slice(src.indexOf("function " + method), src.length)
    const hasDisable = body.includes("eslint-disable-next-line no-restricted-syntax") ||
      rawBody.slice(0, body.length).includes("eslint-disable-next-line no-restricted-syntax")
    if (usesParseBody && pending.has(rel)) console.log("stale-used " + rel)
    if (!usesParseBody && !pending.has(rel)) console.log("new " + rel)
    // 印を付けて逃げていないか（一覧に無いのに disable だけある）
    if (hasDisable && !pending.has(rel)) console.log("undeclared-disable " + rel)
    // 移行が済んだのに印が残っていないか
    if (usesParseBody && hasDisable) console.log("leftover-disable " + rel)
  }
}
for (const rel of pending) {
  if (!seen.has(rel)) console.log("stale-missing " + rel)
}
' "$1" "${2:-}"
}

echo "=== scenario 1: 走査対象がある（fail-open 防止） ==="
# 名前で当てない（R10）。parseBody か、応答を作る以外の `.json(` を持つ route を数える
COUNT="$(find "$API_DIR" -name 'route.ts' -type f -exec grep -lE 'parseBody\(|[A-Za-z_$][A-Za-z0-9_$]*\.json\(' {} + 2>/dev/null | grep -v '__tests__' | wc -l | tr -d ' ')"
if [ "$COUNT" -lt 5 ]; then
  assert_fail "本文を読む route が少なすぎる（$COUNT 本）。走査が壊れている疑い"
else
  assert_ok "$COUNT 本の route を走査する"
fi

echo "=== scenario 2: 検査を通さない新しい route が無い ==="
OUT="$(scan "$API_DIR" "$BASELINE")"
NEW="$(grep '^new ' <<<"$OUT" || true)"
if [ -z "$NEW" ]; then
  assert_ok "検査を通さずに本文を読む新しい route は無い"
else
  assert_fail "本文を検査せずに読む route が増えた" "$NEW
      src/lib/validation/schemas.ts にスキーマを足して safeParse する。
      すぐに直せない事情があるなら scripts/lib/input-validation-baseline.json に理由付きで足す
      （一覧に足すのは借金を認めることなので、理由を具体的に書く）"
fi

echo "=== scenario 3: 一覧が陳腐化していない ==="
STALE_USED="$(grep '^stale-used ' <<<"$OUT" || true)"
STALE_MISSING="$(grep '^stale-missing ' <<<"$OUT" || true)"
if [ -z "$STALE_USED" ]; then
  assert_ok "移行済みなのに一覧に残っている route は無い"
else
  assert_fail "移行が済んでいるのに一覧から消していない" "$STALE_USED
      scripts/lib/input-validation-baseline.json から該当行を消す（一覧は減らすだけ）"
fi
if [ -z "$STALE_MISSING" ]; then
  assert_ok "一覧に載っているのに存在しない route は無い"
else
  assert_fail "一覧に載っている route が見つからない" "$STALE_MISSING
      改名・削除したなら一覧からも消す"
fi

echo "=== scenario 3b: eslint-disable で逃げていない ==="
UNDECLARED="$(grep '^undeclared-disable ' <<<"$OUT" || true)"
LEFTOVER="$(grep '^leftover-disable ' <<<"$OUT" || true)"
if [ -z "$UNDECLARED" ]; then
  assert_ok "一覧に無いのに eslint-disable だけ付いた route は無い"
else
  assert_fail "eslint-disable を付けて検証を飛ばしている route がある" "$UNDECLARED
      parseBody へ移すか、scripts/lib/input-validation-baseline.json に理由付きで足す"
fi
if [ -z "$LEFTOVER" ]; then
  assert_ok "移行済みなのに eslint-disable が残っている route は無い"
else
  assert_fail "移行が済んだのに eslint-disable が残っている" "$LEFTOVER
      不要な disable を消す（付けっぱなしだと次の違反を隠す）"
fi

echo "=== scenario 4: 借金の件数が増えていない ==="
PENDING_COUNT="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((b.pending??[]).length)' "$BASELINE")"
# 2026-09-07 の実測。**この数字は減らすことしかできない**（16 → 全 18 本を移して 0。**0 から上げてはいけない**）
MAX_PENDING=0
if [ "$PENDING_COUNT" -le "$MAX_PENDING" ]; then
  assert_ok "借金は $PENDING_COUNT 本（基準 $MAX_PENDING 以下）"
else
  assert_fail "借金が基準（${MAX_PENDING}）より増えた（現在 ${PENDING_COUNT}）" "移行して減らす。基準を上げてはいけない"
fi

echo "=== scenario 5: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/api/new-thing" "$WORK/api/old-thing" "$WORK/api/moved" "$WORK/api/read-only"
cat > "$WORK/api/new-thing/route.ts" <<'EOF'
export async function POST(request) { const b = await request.json(); return b }
EOF
cat > "$WORK/api/old-thing/route.ts" <<'EOF'
export async function POST(request) { const b = await request.json(); return b }
EOF
cat > "$WORK/api/moved/route.ts" <<'EOF'
import { parseBody } from '@/lib/validation/parse-body'
import { x } from '@/lib/validation/schemas'
export async function POST(request) { const b = await request.json(); return parseBody(request, x) }
EOF
mkdir -p "$WORK/api/sneaky"
cat > "$WORK/api/sneaky/route.ts" <<'EOF'
export async function POST(request) {
  // eslint-disable-next-line no-restricted-syntax -- 印だけ付けて逃げる例
  const b = await request.json()
  return b
}
EOF
cat > "$WORK/api/read-only/route.ts" <<'EOF'
import { NextResponse } from 'next/server'
export async function GET() { return NextResponse.json({ ok: true }) }
EOF
# R10: 引数名を変えて検査から外れる道（従来はここが素通りだった）
mkdir -p "$WORK/api/renamed-arg"
cat > "$WORK/api/renamed-arg/route.ts" <<'EOF'
export async function POST(httpRequest) { const b = await httpRequest.json(); return b }
EOF
# レビューの設計提案 2「複数メソッド」。1 つの route で POST は検証、PUT は生読み。
# **ファイル単位で数えていた頃はここが素通りだった**（2026-09-10 に fixture で実測）
mkdir -p "$WORK/api/mixed-methods"
cat > "$WORK/api/mixed-methods/route.ts" <<'EOF'
import { parseBody } from '@/lib/validation/parse-body'
import { x } from '@/lib/validation/schemas'
export async function POST(request) { return parseBody(request, x) }
export async function PUT(request) { const b = await request.json(); return b }
EOF
# 借金の鍵は route × メソッド。ファイル単位の鍵だと 1 メソッドの免除でファイル全体が免除される
cat > "$WORK/baseline.json" <<'EOF'
{ "pending": [
  { "route": "api/old-thing/route.ts#POST", "why": "借金" },
  { "route": "api/moved/route.ts#POST", "why": "移行済みなのに残っている" },
  { "route": "api/gone/route.ts#POST", "why": "もう無い" }
] }
EOF
FOUT="$(scan "$WORK/api" "$WORK/baseline.json")"
if grep -q '^new api/new-thing/route.ts#POST$' <<<"$FOUT"; then assert_ok "新しい未検証 route を検知"; else assert_fail "新しい route を検知できない" "$FOUT"; fi
if grep -q '^stale-used api/moved/route.ts#POST$' <<<"$FOUT"; then assert_ok "移行済みの消し忘れを検知"; else assert_fail "消し忘れを検知できない" "$FOUT"; fi

# 混在メソッド: POST は通っていて PUT だけが穴。**PUT だけ**が出ること
if grep -q '^new api/mixed-methods/route.ts#PUT$' <<<"$FOUT"; then
  assert_ok "同じ route の中で、検証していないメソッドだけを検知（複数メソッド）"
else
  assert_fail "検証していないメソッドを検知できない（ファイル単位のままの疑い）" "$FOUT"
fi
if grep -q '^new api/mixed-methods/route.ts#POST$' <<<"$FOUT"; then
  assert_fail "検証済みのメソッドまで違反にした" "$FOUT"
else
  assert_ok "検証済みのメソッドは違反にしない（対照）"
fi
if grep -q '^stale-missing api/gone/route.ts#POST$' <<<"$FOUT"; then assert_ok "存在しない行を検知"; else assert_fail "存在しない行を検知できない" "$FOUT"; fi
if grep -q 'api/old-thing' <<<"$FOUT"; then assert_fail "一覧にある借金を違反にした" "$FOUT"; else assert_ok "一覧にある借金は誤検知しない"; fi
if grep -q 'api/read-only' <<<"$FOUT"; then assert_fail "応答を作るだけの route を違反にした（NextResponse.json は本文読みではない）" "$FOUT"; else assert_ok "本文を読まない route は対象外"; fi
if grep -q '^new api/renamed-arg/route.ts#POST$' <<<"$FOUT"; then assert_ok "引数名を変えても本文読みとして検知（R10）"; else assert_fail "引数名を変えると検査から外れる" "$FOUT"; fi
if grep -q '^undeclared-disable api/sneaky/route.ts#POST$' <<<"$FOUT"; then assert_ok "印だけ付けて逃げる route を検知"; else assert_fail "印で逃げる route を検知できない" "$FOUT"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
