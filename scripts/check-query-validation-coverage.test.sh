#!/usr/bin/env bash
# WHY(2026-09-09、#757 の 20 の続き): **本文は閉じたのに、クエリ文字列は開いていた。**
#      本文を読む方法は `parseBody` だけにし、`request.json()` を eslint で禁止して 0 本まで移した。
#      クエリ文字列には同じ仕組みが無く、実測で 12 の route が 26 か所を生読みしていた。
#
#      手書きが分散すると、同じ問いの答えが場所ごとに食い違う。実際に食い違っていた:
#      `/api/news` の limit は `Number.isFinite` だったので **1.5 が素通り**し、
#      共通の `parsePagination`（`Number.isInteger`）と条件が違っていた（E-053）。
#
#      **借金そのものより、借金が静かに増えることのほうが危ない。**
#      新しい route がクエリを検査せずに読んでも誰も気づかない状態を、ここで止める。
#      形は本文側（check-input-validation-coverage.test.sh）と同じ ratchet。
#
#   (a) クエリを生読みする route は、すべて一覧に載っている
#   (b) 一覧に載っているのに生読みが残っていない行は、陳腐化として落とす（消し忘れ検知）
#   (c) 一覧に載っているのに route が存在しない行も落とす（消し忘れ検知）
#   (d) 走査対象が少なすぎたら落とす（fail-open 防止）
#   (e) 借金の件数が maxPending より増えたら落とす（減らすことしかできない）
#   (f) 外す理由が書かれている（「あとで」で済ませない）
#   (g) fixture で (a)(b)(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-query-validation-coverage.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
API_DIR="$REPO_ROOT/src/app/api"
BASELINE="$REPO_ROOT/scripts/lib/query-validation-baseline.json"

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

const seen = new Set()
for (const file of routes) {
  const src = fs.readFileSync(file, "utf8")
  // WHY(コメントを外してから見る): 移行した route はコメントで
  //      「以前は searchParams.get で読んでいた」と説明を残す。文字列だけで見ると
  //      **説明を書いた route が違反になる**（C-040 の裏返し）
  const code = src.replace(/\/\/[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ")
  const rawReads = /searchParams\s*\.\s*get\s*\(/.test(code) || /\bparams\s*\.\s*get\s*\(/.test(code)
  const rel = "api/" + path.relative(apiDir, file).split(path.sep).join("/")
  if (pending.has(rel)) seen.add(rel)
  if (rawReads && !pending.has(rel)) console.log("new " + rel)
  if (!rawReads && pending.has(rel)) console.log("stale-used " + rel)
}
for (const rel of pending) {
  if (!seen.has(rel)) console.log("stale-missing " + rel)
}
' "$1" "${2:-}"
}

echo "=== scenario 1: 走査対象がある（fail-open 防止） ==="
ROUTE_COUNT="$(find "$API_DIR" -name 'route.ts' -type f | wc -l | tr -d ' ')"
if [ "$ROUTE_COUNT" -lt 10 ]; then
  assert_fail "route が少なすぎる（$ROUTE_COUNT 本）。走査が壊れている疑い"
else
  assert_ok "$ROUTE_COUNT 本の route を走査する"
fi

echo "=== scenario 2: 検査を通さない新しい route が無い ==="
OUT="$(scan "$API_DIR" "$BASELINE")"
NEW="$(grep '^new ' <<<"$OUT" || true)"
if [ -z "$NEW" ]; then
  assert_ok "クエリを検査せずに読む新しい route は無い"
else
  assert_fail "クエリを検査せずに読む route が増えた" "$NEW
      parseQuery(request, schema) に置き換える。
      すぐに直せない事情があるなら scripts/lib/query-validation-baseline.json に理由付きで足す
      （一覧に足すのは借金を認めることなので、理由を具体的に書く）"
fi

echo "=== scenario 3: 一覧が陳腐化していない ==="
STALE_USED="$(grep '^stale-used ' <<<"$OUT" || true)"
STALE_MISSING="$(grep '^stale-missing ' <<<"$OUT" || true)"
if [ -z "$STALE_USED" ]; then
  assert_ok "移行済みなのに一覧に残っている route は無い"
else
  assert_fail "移行が済んでいるのに一覧から消していない" "$STALE_USED
      scripts/lib/query-validation-baseline.json から該当行を消す（一覧は減らすだけ）"
fi
if [ -z "$STALE_MISSING" ]; then
  assert_ok "一覧に載っているのに存在しない route は無い"
else
  assert_fail "一覧に載っている route が見つからない" "$STALE_MISSING
      改名・削除したなら一覧からも消す"
fi

echo "=== scenario 4: 借金の件数が増えていない（減らすことしかできない） ==="
PENDING_COUNT="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((b.pending??[]).length)' "$BASELINE")"
MAX_PENDING="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(b.maxPending)' "$BASELINE")"
if [ "$MAX_PENDING" = "undefined" ]; then
  assert_fail "一覧に maxPending が無い（増えても気づけない）"
elif [ "$PENDING_COUNT" -le "$MAX_PENDING" ]; then
  assert_ok "借金は $PENDING_COUNT 本（基準 $MAX_PENDING 以下）"
else
  assert_fail "借金が基準（${MAX_PENDING}）より増えた（現在 ${PENDING_COUNT}）" "移行して減らす。基準を上げてはいけない"
fi

echo "=== scenario 5: 外す理由が書かれている ==="
SHORT="$(node -e '
const b = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
for (const row of b.pending ?? []) {
  if (!row.why || row.why.trim().length < 15) console.log(row.route)
}
' "$BASELINE")"
if [ -z "$SHORT" ]; then
  assert_ok "すべての行に具体的な理由がある"
else
  assert_fail "理由が短すぎる行がある" "$SHORT"
fi

echo "=== scenario 6: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/api/new-thing" "$WORK/api/old-thing" "$WORK/api/moved" "$WORK/api/no-query" "$WORK/api/commented"
cat > "$WORK/api/new-thing/route.ts" <<'EOF'
export async function GET(request) { return request.nextUrl.searchParams.get('x') }
EOF
cat > "$WORK/api/old-thing/route.ts" <<'EOF'
export async function GET(request) { return request.nextUrl.searchParams.get('x') }
EOF
cat > "$WORK/api/moved/route.ts" <<'EOF'
import { parseQuery } from '@/lib/validation/parse-query'
export async function GET(request) { return parseQuery(request, schema) }
EOF
cat > "$WORK/api/no-query/route.ts" <<'EOF'
export async function GET() { return null }
EOF
cat > "$WORK/api/commented/route.ts" <<'EOF'
import { parseQuery } from '@/lib/validation/parse-query'
// 以前は searchParams.get('x') で読んでいた（2026-09-09 に parseQuery へ移した）
export async function GET(request) { return parseQuery(request, schema) }
EOF
cat > "$WORK/baseline.json" <<'EOF'
{ "maxPending": 3, "pending": [
  { "route": "api/old-thing/route.ts", "why": "借金として残している具体的な理由" },
  { "route": "api/moved/route.ts", "why": "移行済みなのに一覧に残っている行" },
  { "route": "api/gone/route.ts", "why": "もう存在しない route の行" }
] }
EOF
FOUT="$(scan "$WORK/api" "$WORK/baseline.json")"
if grep -q '^new api/new-thing/route.ts$' <<<"$FOUT"; then assert_ok "新しい未検証 route を検知"; else assert_fail "新しい route を検知できない" "$FOUT"; fi
if grep -q '^stale-used api/moved/route.ts$' <<<"$FOUT"; then assert_ok "移行済みの消し忘れを検知"; else assert_fail "消し忘れを検知できない" "$FOUT"; fi
if grep -q '^stale-missing api/gone/route.ts$' <<<"$FOUT"; then assert_ok "存在しない行を検知"; else assert_fail "存在しない行を検知できない" "$FOUT"; fi
if grep -q 'api/old-thing' <<<"$FOUT"; then assert_fail "一覧にある借金を違反にした" "$FOUT"; else assert_ok "一覧にある借金は誤検知しない"; fi
if grep -q 'api/no-query' <<<"$FOUT"; then assert_fail "クエリを読まない route を違反にした" "$FOUT"; else assert_ok "クエリを読まない route は対象外"; fi
if grep -q 'api/commented' <<<"$FOUT"; then assert_fail "コメント内の記述を違反にした" "$FOUT"; else assert_ok "コメントに残した説明は違反にしない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
