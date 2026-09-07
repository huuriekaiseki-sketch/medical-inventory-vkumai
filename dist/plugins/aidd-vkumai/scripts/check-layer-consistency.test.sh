#!/usr/bin/env bash
# WHY: issue #757 の 20。2026-09-07 に見つけた実害 8 件のうち **6 件が層の間の食い違い**だった。
#        - API が DB より緩い（数量 0 を通す。DB は I-010 で 1 以上）
#        - API が DB より厳しい（互換の備考が API 500・DB 1,000）
#        - 型（ロジック層）の必須項目を API が見ていない（代理店商品の入数・償還価格）
#        - 設定に無い値が DB にある（医師名・使用期限・仕入先）
#      どれも**作る段階で 4 層（UI / API / ロジック / DB）を突き合わせていれば起きなかった**。
#      人の注意力に任せると同じことが起きるので、DB と API の突合を機械で行う。
#
#      UI 層はまだ入っていない（画面の maxlength は防御ではないので優先度が低い）。
#      入れるときは layer-map.json に ui のキーを足す。
#
#   (a) DB の CHECK がある列は、すべて layer-map.json に分類がある（api か serverOnly）
#   (b) api と書いた列は、その zod スキーマに同じ名前のフィールドがある
#   (c) 種類が合っている（maxLength は requiredText/optionalText、min は money/quantity、enum は z.enum）
#   (d) layer-map.json に載っているのに DB に CHECK が無い列は陳腐化として落とす
#   (e) 走査で条件が 1 つも取れなければ落とす（fail-open 防止）
#   (f) fixture で (a)(b)(c)(d) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-layer-consistency.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCANNER="$REPO_ROOT/scripts/lib/scan-db-constraints.mjs"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
MAP="$REPO_ROOT/scripts/lib/layer-map.json"
SCHEMAS="$REPO_ROOT/src/lib/validation/schemas.ts"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1 migrations, $2 map, $3 schemas
# 出力: "unclassified <col>" / "stale <col>" / "missing-field <col> <schema.field>" / "wrong-kind <col> <kind>"
compare() {
  node -e '
const { execFileSync } = require("child_process")
const fs = require("fs")
const [scanner, migrations, mapPath, schemasPath] = process.argv.slice(1)

const db = JSON.parse(execFileSync(process.execPath, [scanner, migrations], { encoding: "utf8" }))
const map = JSON.parse(fs.readFileSync(mapPath, "utf8")).columns ?? {}
const schemas = fs.existsSync(schemasPath) ? fs.readFileSync(schemasPath, "utf8") : ""

// スキーマ本文をスキーマ名ごとに切り出す（export const X = z.object({ ... }) の中身）
const blocks = new Map()
for (const m of schemas.matchAll(/export const ([A-Za-z0-9_]+)\s*=\s*z\.object\(\{([\s\S]*?)\n\}\)/g)) {
  blocks.set(m[1], m[2])
}
// z.object を直に返さないもの（配列の中の無名 object など）は、スキーマ全体を最後の受け皿にする
const whole = schemas

const HELPERS = {
  maxLength: /(requiredText|optionalText)\s*\(/,
  min: /(money|quantity)\b/,
  enum: /z\.enum\s*\(/,
}

for (const [col, entries] of Object.entries(db)) {
  const rule = map[col]
  if (!rule) { console.log("unclassified " + col); continue }
  if (rule.serverOnly) continue
  if (!rule.api) { console.log("unclassified " + col); continue }

  const [schemaName, field] = rule.api.split(".")
  const body = blocks.get(schemaName) ?? whole
  // フィールドの行を探す。"field: 値" と省略記法 "field," の両方を受ける
  const named = new RegExp("^\\s*" + field + "\\s*:")
  const shorthand = new RegExp("^\\s*" + field + "\\s*,\\s*$")
  const line = body.split("\n").find((l) => named.test(l) || shorthand.test(l))
  if (!line) { console.log("missing-field " + col + " " + rule.api); continue }

  // WHY: 判定するのは**値の側**だけ。"quantity: z.number()..." のようにフィールド名が
  //      ヘルパー名と同じだと、行全体で照合すると素の z.number() を見逃す（2026-09-07 実測）
  const isShorthand = shorthand.test(line)
  const value = isShorthand ? field : line.slice(line.indexOf(":") + 1)

  for (const e of entries) {
    const re = HELPERS[e.kind]
    if (!re) continue
    const ok = re.test(value)
    if (!ok) console.log("wrong-kind " + col + " " + e.kind + " (" + rule.api + ")")
  }
}

for (const col of Object.keys(map)) {
  if (!db[col]) console.log("stale " + col)
}
' "$SCANNER" "$1" "$2" "$3"
}

echo "=== scenario 1: DB の条件を拾えている（fail-open 防止） ==="
COUNT="$(node "$SCANNER" "$MIGRATIONS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(Object.keys(JSON.parse(s)).length))')"
if [ "${COUNT:-0}" -lt 20 ]; then
  assert_fail "DB の CHECK が少なすぎる（$COUNT 列）。走査が壊れている疑い"
else
  assert_ok "$COUNT 列の CHECK を走査する"
fi

echo "=== scenario 2: 分類していない列が無い ==="
OUT="$(compare "$MIGRATIONS" "$MAP" "$SCHEMAS")"
UNCLASSIFIED="$(printf '%s\n' "$OUT" | grep '^unclassified ' || true)"
if [ -z "$UNCLASSIFIED" ]; then
  assert_ok "DB の CHECK はすべて layer-map.json で分類されている"
else
  assert_fail "分類していない CHECK がある（作る段階で層を揃えていない）" "$UNCLASSIFIED
      scripts/lib/layer-map.json に api（利用者が送れる）か serverOnly（送れない・理由必須）を足す"
fi

echo "=== scenario 3: api と書いた列は zod にも同じ規則がある ==="
MISSING="$(printf '%s\n' "$OUT" | grep '^missing-field ' || true)"
WRONG="$(printf '%s\n' "$OUT" | grep '^wrong-kind ' || true)"
if [ -z "$MISSING" ]; then
  assert_ok "対応するフィールドがすべて zod スキーマにある"
else
  assert_fail "DB は守っているのに API の入口に無い" "$MISSING
      src/lib/validation/schemas.ts にフィールドを足す（API が DB より緩い状態）"
fi
if [ -z "$WRONG" ]; then
  assert_ok "規則の種類が DB と揃っている"
else
  assert_fail "規則の種類が DB と揃っていない" "$WRONG
      maxLength は requiredText/optionalText、min は money/quantity、enum は z.enum を使う"
fi

echo "=== scenario 4: 対応表が陳腐化していない ==="
STALE="$(printf '%s\n' "$OUT" | grep '^stale ' || true)"
if [ -z "$STALE" ]; then
  assert_ok "DB に無い列が対応表に残っていない"
else
  assert_fail "対応表に載っているのに DB に CHECK が無い" "$STALE
      CHECK を消したなら対応表からも消す"
fi

echo "=== scenario 5: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/migrations"
cat > "$WORK/migrations/0001.sql" <<'EOF'
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  body TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount INTEGER NOT NULL,
  hidden TEXT NOT NULL,
  forgotten TEXT NOT NULL
);
ALTER TABLE notes ADD CONSTRAINT c1 CHECK (length(body) <= 100) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c2 CHECK (kind IN ('a', 'b')) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c3 CHECK (amount >= 1) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c4 CHECK (length(hidden) <= 50) NOT VALID;
ALTER TABLE notes ADD CONSTRAINT c5 CHECK (length(forgotten) <= 50) NOT VALID;
EOF
cat > "$WORK/map.json" <<'EOF'
{ "columns": {
  "notes.body": { "api": "noteSchema.body" },
  "notes.kind": { "api": "noteSchema.kind" },
  "notes.amount": { "api": "noteSchema.amount" },
  "notes.hidden": { "serverOnly": "サーバーが入れる" },
  "notes.gone": { "api": "noteSchema.gone" }
} }
EOF
cat > "$WORK/schemas.ts" <<'EOF'
export const noteSchema = z.object({
  body: z.string().max(100),
  kind: z.enum(['a', 'b']),
})
EOF
FOUT="$(compare "$WORK/migrations" "$WORK/map.json" "$WORK/schemas.ts")"
if printf '%s' "$FOUT" | grep -q '^unclassified notes.forgotten$'; then assert_ok "分類漏れを検知"; else assert_fail "分類漏れを検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q '^missing-field notes.amount '; then assert_ok "API に無いフィールドを検知"; else assert_fail "欠落を検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q '^wrong-kind notes.body maxLength'; then assert_ok "生の .max() を検知（ヘルパーを使っていない）"; else assert_fail "種類の不一致を検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q '^stale notes.gone$'; then assert_ok "陳腐化した行を検知"; else assert_fail "陳腐化を検知できない" "$FOUT"; fi
if printf '%s' "$FOUT" | grep -q 'notes.hidden'; then assert_fail "serverOnly の列を違反にした" "$FOUT"; else assert_ok "serverOnly は誤検知しない"; fi
if printf '%s' "$FOUT" | grep -q 'wrong-kind notes.kind'; then assert_fail "正しい z.enum を違反にした" "$FOUT"; else assert_ok "正しい enum は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
