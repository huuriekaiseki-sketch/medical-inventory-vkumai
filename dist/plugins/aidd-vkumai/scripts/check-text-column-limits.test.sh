#!/usr/bin/env bash
# WHY: issue #757 の 20。自由入力の列に上限が無いと、API を通らない経路（RPC の直叩き・
#      service_role・別のクライアント）からいくらでも長い文字列が入る。
#      2026-09-07 に 10 列を足したが、**足し損ねが 3 列あった**
#      （categories.description・product_compatibilities.note・access_denials.route）。
#      人が数え直すのでは同じ見落としが起きるので、機械で数える。
#
#      分類は scripts/lib/scan-text-columns.mjs が migration を適用順に畳み込んで行う。
#        guarded  … length(col) <= N の CHECK がある
#        bounded  … col IN ('a','b') の CHECK がある（固定語なので長さに上限がある）
#        unguarded… どちらも無い → 一覧（scripts/lib/text-column-baseline.json）に理由が要る
#
#   (a) 上限も固定語も無い TEXT 列は、すべて一覧に理由付きで載っている
#   (b) 一覧に載っているのに実は上限が付いた列は、陳腐化として落とす（消し忘れ検知）
#   (c) 走査対象が少なすぎたら落とす（fail-open 防止）
#   (d) fixture で (a)(b) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-text-column-limits.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCANNER="$REPO_ROOT/scripts/lib/scan-text-columns.mjs"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
BASELINE="$REPO_ROOT/scripts/lib/text-column-baseline.json"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1: migrations ディレクトリ, $2: 一覧
# 出力: "new <col>" / "stale <col>"
compare() {
  node -e '
const { execFileSync } = require("child_process")
const fs = require("fs")
const scanner = process.argv[1]
const migrations = process.argv[2]
const baselinePath = process.argv[3]

const scanned = JSON.parse(execFileSync(process.execPath, [scanner, migrations], { encoding: "utf8" }))
const exempt = new Set()
if (fs.existsSync(baselinePath)) {
  const b = JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  for (const row of b.exempt ?? []) exempt.add(row.column)
}

for (const col of scanned.unguarded) {
  if (!exempt.has(col)) console.log("new " + col)
}
const covered = new Set([...scanned.guarded, ...scanned.bounded])
for (const col of exempt) {
  if (covered.has(col)) console.log("stale " + col)
}
' "$SCANNER" "$1" "$2"
}

echo "=== scenario 1: 走査できている（fail-open 防止） ==="
TOTAL="$(node "$SCANNER" "$MIGRATIONS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).total))')"
if [ "${TOTAL:-0}" -lt 20 ]; then
  assert_fail "TEXT 列が少なすぎる（$TOTAL 列）。走査が壊れている疑い"
else
  assert_ok "$TOTAL 列の TEXT 列を走査する"
fi

echo "=== scenario 2: 上限の無い新しい自由入力の列が無い ==="
OUT="$(compare "$MIGRATIONS" "$BASELINE")"
NEW="$(grep '^new ' <<<"$OUT" || true)"
if [ -z "$NEW" ]; then
  assert_ok "上限も固定語も無い列は、すべて一覧に理由がある"
else
  assert_fail "上限の無い自由入力の列が増えた" "$NEW
      migration に length(col) <= N の CHECK を足す（N は aidd.config.json の limits.textLength から選ぶ）。
      利用者が書けない列なら scripts/lib/text-column-baseline.json に理由付きで足す"
fi

echo "=== scenario 3: 一覧が陳腐化していない ==="
STALE="$(grep '^stale ' <<<"$OUT" || true)"
if [ -z "$STALE" ]; then
  assert_ok "上限が付いたのに一覧に残っている列は無い"
else
  assert_fail "上限が付いたのに一覧から消していない" "$STALE
      scripts/lib/text-column-baseline.json から該当行を消す"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/migrations"
cat > "$WORK/migrations/0001_init.sql" <<'EOF'
CREATE TABLE notes (
  id UUID PRIMARY KEY,
  body TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('a', 'b')),
  memo TEXT,
  internal TEXT
);
ALTER TABLE notes ADD CONSTRAINT notes_len CHECK (length(body) <= 100) NOT VALID;
EOF
cat > "$WORK/baseline.json" <<'EOF'
{ "exempt": [
  { "column": "notes.internal", "why": "サーバーが書く" },
  { "column": "notes.body", "why": "上限が付いたのに消し忘れている" }
] }
EOF
FOUT="$(compare "$WORK/migrations" "$WORK/baseline.json")"
if grep -q '^new notes.memo$' <<<"$FOUT"; then assert_ok "上限の無い自由入力を検知"; else assert_fail "検知できない" "$FOUT"; fi
if grep -q '^stale notes.body$' <<<"$FOUT"; then assert_ok "消し忘れを検知"; else assert_fail "消し忘れを検知できない" "$FOUT"; fi
if grep -q 'notes.kind' <<<"$FOUT"; then assert_fail "固定語の列を違反にした" "$FOUT"; else assert_ok "固定語の列は誤検知しない"; fi
if grep -q 'new notes.internal' <<<"$FOUT"; then assert_fail "一覧にある列を違反にした" "$FOUT"; else assert_ok "一覧にある列は誤検知しない"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
