#!/usr/bin/env bash
# WHY: issue #757 の 20。2026-09-07 に zod で入口の検証を作ったが、適用できたのは 18 本中 2 本。
#      残りは借金として一覧（scripts/lib/input-validation-baseline.json）に置いた。
#      **借金そのものより、借金が静かに増えることのほうが危ない。**
#      新しい route が本文を検査せずに読んでも誰も気づかない状態を、ここで止める。
#
#      同じ形の ratchet がこのリポジトリには既にある（攻撃表・制約カバレッジ・
#      ミューテーションスコア）。「今あるものは許す。増えたら落とす。減ったら基準を下げる」。
#
#   (a) 本文を読む route はすべて、スキーマを通しているか一覧に載っている
#   (b) 一覧に載っているのに実はスキーマを使っている行は、陳腐化として落とす（消し忘れ検知）
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

const seen = new Set()
for (const file of routes) {
  const src = fs.readFileSync(file, "utf8")
  // 本文を読まない route（GET だけ）は対象外
  if (!src.includes("request.json()")) continue
  const rel = "api/" + path.relative(apiDir, file).split(path.sep).join("/")
  seen.add(rel)
  const usesSchema = src.includes("@/lib/validation/schemas")
  if (usesSchema && pending.has(rel)) console.log("stale-used " + rel)
  if (!usesSchema && !pending.has(rel)) console.log("new " + rel)
}
for (const rel of pending) {
  if (!seen.has(rel)) console.log("stale-missing " + rel)
}
' "$1" "${2:-}"
}

echo "=== scenario 1: 走査対象がある（fail-open 防止） ==="
COUNT="$(find "$API_DIR" -name 'route.ts' -type f -exec grep -l 'request.json()' {} + 2>/dev/null | wc -l | tr -d ' ')"
if [ "$COUNT" -lt 5 ]; then
  assert_fail "本文を読む route が少なすぎる（$COUNT 本）。走査が壊れている疑い"
else
  assert_ok "$COUNT 本の route を走査する"
fi

echo "=== scenario 2: 検査を通さない新しい route が無い ==="
OUT="$(scan "$API_DIR" "$BASELINE")"
NEW="$(printf '%s\n' "$OUT" | grep '^new ' || true)"
if [ -z "$NEW" ]; then
  assert_ok "検査を通さずに本文を読む新しい route は無い"
else
  assert_fail "本文を検査せずに読む route が増えた" "$NEW
      src/lib/validation/schemas.ts にスキーマを足して safeParse する。
      すぐに直せない事情があるなら scripts/lib/input-validation-baseline.json に理由付きで足す
      （一覧に足すのは借金を認めることなので、理由を具体的に書く）"
fi

echo "=== scenario 3: 一覧が陳腐化していない ==="
STALE_USED="$(printf '%s\n' "$OUT" | grep '^stale-used ' || true)"
STALE_MISSING="$(printf '%s\n' "$OUT" | grep '^stale-missing ' || true)"
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

echo "=== scenario 4: 借金の件数が増えていない ==="
PENDING_COUNT="$(node -e 'const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((b.pending??[]).length)' "$BASELINE")"
# 2026-09-07 の実測。**この数字は減らすことしかできない**
MAX_PENDING=16
if [ "$PENDING_COUNT" -le "$MAX_PENDING" ]; then
  assert_ok "借金は $PENDING_COUNT 本（基準 $MAX_PENDING 以下）"
else
  assert_fail "借金が基準（$MAX_PENDING）より増えた（現在 $PENDING_COUNT）" "移行して減らす。基準を上げてはいけない"
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
import { x } from '@/lib/validation/schemas'
export async function POST(request) { const b = await request.json(); return x.safeParse(b) }
EOF
cat > "$WORK/api/read-only/route.ts" <<'EOF'
export async function GET() { return null }
EOF
cat > "$WORK/baseline.json" <<'EOF'
{ "pending": [
  { "route": "api/old-thing/route.ts", "why": "借金" },
  { "route": "api/moved/route.ts", "why": "移行済みなのに残っている" },
  { "route": "api/gone/route.ts", "why": "もう無い" }
] }
EOF
FOUT="$(scan "$WORK/api" "$WORK/baseline.json")"
if printf '%s' "$FOUT" | grep -q '^new api/new-thing/route.ts$'; then assert_ok "新しい未検証 route を検知"; else assert_fail "新しい route を検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q '^stale-used api/moved/route.ts$'; then assert_ok "移行済みの消し忘れを検知"; else assert_fail "消し忘れを検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q '^stale-missing api/gone/route.ts$'; then assert_ok "存在しない行を検知"; else assert_fail "存在しない行を検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q 'api/old-thing'; then assert_fail "一覧にある借金を違反にした" "$FOUT"; else assert_ok "一覧にある借金は誤検知しない"; fi
if printf '%s' "$FOUT" | grep -q 'api/read-only'; then assert_fail "本文を読まない route を違反にした" "$FOUT"; else assert_ok "本文を読まない route は対象外"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
