#!/usr/bin/env bash
# WHY: issue #757 の 19（性能と上限）。PostgreSQL は外部キーを作っても**参照する側**に索引を
#      作らない。索引が無いと親を 1 行消すたびに子テーブルを全走査するので、CASCADE は
#      行数の二乗で重くなる。2026-09-07 の実測では、発注 12,000 / 明細 36,000 の施設を
#      削除しようとして statement timeout になり、**施設を消せなかった**。
#      索引を足すと同じ規模が 680 ms で終わる（docs/agents/performance-baseline.md）。
#
#      新しい外部キーを足したときに索引を忘れると同じ穴が空くので、
#      migration の SQL から「外部キー列」と「索引の先頭列」を突き合わせて 0 件を固定する。
#
#   (a) CREATE TABLE 内の `<col> ... REFERENCES <table>` と
#       ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (<col>) の両方を拾う
#   (b) CREATE INDEX / UNIQUE INDEX / PRIMARY KEY / UNIQUE 制約の**先頭列**を索引として数える
#       （複合索引は先頭列だけが単独検索に効く）
#   (c) 索引の無い外部キー列が 1 つでもあれば失敗する
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-foreign-key-indexes.test.sh
# 環境変数（テスト用注入ポイント）: FK_INDEX_MIGRATIONS_DIR
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS="${FK_INDEX_MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=migration ディレクトリ。「table.col」の形で索引の無い外部キー列を 1 行ずつ出す
find_unindexed_fks() {
  node -e '
const fs = require("fs")
const path = require("path")
const dir = process.argv[1]
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  : []
const sql = files.map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n")
// コメントを落としてから解析する（コメント内の例文を拾わないため）
const clean = sql.replace(/--[^\n]*/g, " ")

const fks = new Set()
const indexed = new Set()

// CREATE TABLE <name> ( ... ) の中身を取り出す
for (const m of clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi)) {
  const table = m[1].toLowerCase()
  let depth = 0
  let i = m.index + m[0].length - 1
  const start = i + 1
  for (; i < clean.length; i++) {
    if (clean[i] === "(") depth++
    else if (clean[i] === ")") { depth--; if (depth === 0) break }
  }
  const body = clean.slice(start, i)
  for (const line of body.split(",")) {
    const col = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(line)
    if (col && /\breferences\b/i.test(line)) fks.add(`${table}.${col[1].toLowerCase()}`)
    // 列定義に primary key / unique が付いていれば単独索引になる
    if (col && /\b(primary\s+key|unique)\b/i.test(line)) indexed.add(`${table}.${col[1].toLowerCase()}`)
    // 表制約としての PRIMARY KEY (a, b) / UNIQUE (a, b) は先頭列だけ
    const tbl = /^\s*(?:constraint\s+"?[a-z0-9_]+"?\s+)?(primary\s+key|unique)\s*\(\s*"?([a-z_][a-z0-9_]*)"?/i.exec(line)
    if (tbl) indexed.add(`${table}.${tbl[2].toLowerCase()}`)
  }
}

// ALTER TABLE <t> ADD CONSTRAINT ... FOREIGN KEY (<col>)
for (const m of clean.matchAll(
  /alter\s+table\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,400}?foreign\s+key\s*\(\s*"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  fks.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
}
// ALTER TABLE <t> ADD CONSTRAINT ... PRIMARY KEY/UNIQUE (<col>...)
for (const m of clean.matchAll(
  /alter\s+table\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,400}?(?:primary\s+key|unique)\s*\(\s*"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  indexed.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
}

// CREATE [UNIQUE] INDEX ... ON <table> (<col>, ...) — 先頭列だけを索引として数える
for (const m of clean.matchAll(
  /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?[a-z0-9_]*"?\s*on\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  indexed.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
}

const missing = [...fks].filter((f) => !indexed.has(f)).sort()
for (const m of missing) console.log(m)
' "$1"
}

echo "=== scenario 1: 実態の migration に索引の無い外部キーが無い ==="
MISSING="$(find_unindexed_fks "$MIGRATIONS")"
if [ -z "$MISSING" ]; then
  assert_ok "索引の無い外部キーなし"
else
  assert_fail "外部キー列に索引が無い（親を消すたびに子テーブルを全走査する）" "$MISSING
      直し方: CREATE INDEX IF NOT EXISTS idx_<table>_<col> ON <table> (<col>); を migration に足す"
fi

echo "=== scenario 2: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bad" "$WORK/good"

cat > "$WORK/bad/0001_init.sql" <<'EOF'
CREATE TABLE parents (
  id UUID PRIMARY KEY
);
CREATE TABLE children (
  id UUID PRIMARY KEY,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  code TEXT
);
-- 索引は別の列にしか無い（先頭列が違う複合索引も効かない）
CREATE INDEX idx_children_code ON children (code);
CREATE INDEX idx_children_code_parent ON children (code, parent_id);
EOF
BAD="$(find_unindexed_fks "$WORK/bad")"
if printf '%s\n' "$BAD" | grep -qx 'children.parent_id'; then
  assert_ok "索引の無い外部キーを検知"
else
  assert_fail "索引の無い外部キーを検知できない" "$BAD"
fi
if printf '%s\n' "$BAD" | grep -qx 'children.code'; then
  assert_fail "外部キーでない列を誤検知した" "$BAD"
else
  assert_ok "外部キーでない列は対象外"
fi

cat > "$WORK/good/0001_init.sql" <<'EOF'
CREATE TABLE parents (
  id UUID PRIMARY KEY
);
CREATE TABLE children (
  id UUID PRIMARY KEY,
  parent_id UUID NOT NULL REFERENCES parents(id) ON DELETE CASCADE
);
CREATE INDEX idx_children_parent_id ON children (parent_id);
EOF
cat > "$WORK/good/0002_later_fk.sql" <<'EOF'
ALTER TABLE children ADD COLUMN owner_id UUID;
ALTER TABLE children
  ADD CONSTRAINT children_owner_fkey FOREIGN KEY (owner_id) REFERENCES parents (id) NOT VALID;
CREATE INDEX IF NOT EXISTS idx_children_owner_id ON children (owner_id);
EOF
GOOD="$(find_unindexed_fks "$WORK/good")"
if [ -z "$GOOD" ]; then
  assert_ok "索引を足した fixture は誤検知しない（後付けの外部キーも見る）"
else
  assert_fail "索引があるのに検知した" "$GOOD"
fi

cat > "$WORK/good/0003_missing.sql" <<'EOF'
ALTER TABLE children ADD COLUMN reviewer_id UUID;
ALTER TABLE children
  ADD CONSTRAINT children_reviewer_fkey FOREIGN KEY (reviewer_id) REFERENCES parents (id) NOT VALID;
EOF
LATER="$(find_unindexed_fks "$WORK/good")"
if printf '%s\n' "$LATER" | grep -qx 'children.reviewer_id'; then
  assert_ok "後から足した外部キーの索引漏れを検知"
else
  assert_fail "後付けの外部キーの索引漏れを検知できない" "$LATER"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
