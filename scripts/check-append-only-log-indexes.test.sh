#!/usr/bin/env bash
# WHY: issue #757 の 19（規模の実測）・32（量の上限、quota-inventory の Q-004）。
#      append-only の記録表（監査ログ・拒否の記録・特権操作）は「全表の変更が 1 表に集まる」
#      ので、この製品で**いちばん早く大きくなる**。読み方は必ず「新しい順」と「この人の分」で、
#      それを支える索引が無いと LIMIT 50 でも毎回 表全体を走査する。
#
#      2026-09-08 に本物と同じ列・同じ索引の複製表 20 万行（79 MB）で実測したところ、
#      `audit_log` の**既定の画面**（絞り込みなし・新しい順・50 件）が
#      Seq Scan 5,791 blocks（19.5 ms）だった。索引を足すと 5 blocks（0.03 ms）。
#      `access_denials` と `privileged_operations` には最初から両方あり、audit_log だけ
#      抜けていた（同じ形の表なのに、作った順で片方だけ穴が空いていた）。
#
#      新しい記録表を足したときに同じ穴が空かないよう、migration の SQL から
#      「append-only の表」と「索引の先頭列」を突き合わせて 0 件を固定する。
#
#   (a) append-only の表を機械的に見つける
#       （CREATE TRIGGER ... ON <table> ... EXECUTE FUNCTION <...>_immutable()）
#   (b) その表が occurred_at 列を持つなら、先頭列が occurred_at の索引を要求する
#   (c) その表が actor_id 列を持つなら、先頭列が actor_id の索引を要求する
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 限界:
#   - **索引があることしか見ない。** その索引を計画器が実際に選ぶかは見ていない
#     （それは EXPLAIN で測る話で、記録は docs/agents/performance-baseline.md）。
#   - **append-only でない記録表は対象外。** 印は `_immutable()` トリガーなので、
#     消せる記録表を足した場合はここに引っかからない。
#   - **列の組み合わせまでは見ない。** 先頭列が合っていれば通す（複合索引の 2 列目は不問）。
#
# 実行: bash scripts/check-append-only-log-indexes.test.sh
# 環境変数（テスト用注入ポイント）: LOG_INDEX_MIGRATIONS_DIR
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS="${LOG_INDEX_MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# $1=migration ディレクトリ。「table.col」の形で索引の無い読み取り列を 1 行ずつ出す
find_unindexed_log_columns() {
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

// 読み方が決まっている列。ここに無い列は要求しない
const READ_COLUMNS = ["occurred_at", "actor_id"]

// (a) append-only の表 = _immutable() を呼ぶトリガーが付いている表
const appendOnly = new Set()
for (const m of clean.matchAll(
  /create\s+trigger\s+[a-z0-9_]+[\s\S]{0,200}?\son\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,200}?execute\s+function\s+(?:public\.)?[a-z0-9_]*_immutable\s*\(/gi,
)) {
  appendOnly.add(m[1].toLowerCase())
}

// 表ごとの列（CREATE TABLE と ALTER TABLE ADD COLUMN の両方）
const columns = new Map()
const addColumn = (t, c) => {
  const key = t.toLowerCase()
  if (!columns.has(key)) columns.set(key, new Set())
  columns.get(key).add(c.toLowerCase())
}
for (const m of clean.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi)) {
  const table = m[1]
  let depth = 0
  let i = m.index + m[0].length - 1
  const start = i + 1
  for (; i < clean.length; i++) {
    if (clean[i] === "(") depth++
    else if (clean[i] === ")") { depth--; if (depth === 0) break }
  }
  for (const line of clean.slice(start, i).split(",")) {
    const col = /^\s*"?([a-z_][a-z0-9_]*)"?\s+[a-z]/i.exec(line)
    if (col) addColumn(table, col[1])
  }
}
for (const m of clean.matchAll(
  /alter\s+table\s+(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  addColumn(m[1], m[2])
}

// 索引の先頭列（複合索引は先頭列だけが単独の絞り込み・整列に効く）
const indexed = new Set()
for (const m of clean.matchAll(
  /create\s+(?:unique\s+)?index\s+(?:concurrently\s+)?(?:if\s+not\s+exists\s+)?"?[a-z0-9_]*"?\s*on\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(\s*"?([a-z_][a-z0-9_]*)"?/gi,
)) {
  indexed.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`)
}

const missing = []
for (const table of [...appendOnly].sort()) {
  const cols = columns.get(table) ?? new Set()
  for (const col of READ_COLUMNS) {
    if (cols.has(col) && !indexed.has(`${table}.${col}`)) missing.push(`${table}.${col}`)
  }
}
for (const m of missing.sort()) console.log(m)
' "$1"
}

echo "=== scenario 1: 実態の migration に索引の無い記録表が無い ==="
MISSING="$(find_unindexed_log_columns "$MIGRATIONS")"
if [ -z "$MISSING" ]; then
  assert_ok "append-only の記録表に読み取りの索引がそろっている"
else
  assert_fail "記録表の読み取り列に索引が無い（LIMIT を付けても表全体を走査する）" "$MISSING
      直し方: CREATE INDEX IF NOT EXISTS <table>_<col>_idx ON <table> (<col> DESC); を migration に足す"
fi

echo "=== scenario 2: append-only の 3 表を実際に見つけている（空振りしていない） ==="
FOUND="$(node -e '
const fs = require("fs"), path = require("path")
const dir = process.argv[1]
const sql = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()
  .map((f) => fs.readFileSync(path.join(dir, f), "utf8")).join("\n").replace(/--[^\n]*/g, " ")
const s = new Set()
for (const m of sql.matchAll(
  /create\s+trigger\s+[a-z0-9_]+[\s\S]{0,200}?\son\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,200}?execute\s+function\s+(?:public\.)?[a-z0-9_]*_immutable\s*\(/gi,
)) s.add(m[1].toLowerCase())
console.log([...s].sort().join(" "))
' "$MIGRATIONS")"
# WHY: 「0 件だから違反も 0 件」で通ってしまう空振りを防ぐ。表を見つけていること自体を測る
if [ "$FOUND" = "access_denials audit_log privileged_operations" ]; then
  assert_ok "append-only の表を 3 つ見つけた: $FOUND"
else
  assert_fail "append-only の表の顔ぶれが変わった（増えたなら期待値を更新する）" "見つけた: $FOUND"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bad" "$WORK/good" "$WORK/notlog" "$WORK/later"

cat > "$WORK/bad/0001_init.sql" <<'EOF'
CREATE TABLE some_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID,
  note TEXT
);
-- 索引は別の列にしか無い（先頭列が違う複合索引も効かない）
CREATE INDEX some_log_note_idx ON some_log (note);
CREATE INDEX some_log_note_occurred_idx ON some_log (note, occurred_at DESC);
CREATE TRIGGER some_log_no_update_delete
  BEFORE UPDATE OR DELETE ON some_log
  FOR EACH ROW EXECUTE FUNCTION some_log_immutable();
EOF
BAD="$(find_unindexed_log_columns "$WORK/bad")"
if grep -qx 'some_log.occurred_at' <<<"$BAD"; then
  assert_ok "新しい順の索引が無いことを検知"
else
  assert_fail "occurred_at の索引欠けを検知できない" "$BAD"
fi
if grep -qx 'some_log.actor_id' <<<"$BAD"; then
  assert_ok "人で絞る索引が無いことを検知"
else
  assert_fail "actor_id の索引欠けを検知できない" "$BAD"
fi
if grep -qx 'some_log.note' <<<"$BAD"; then
  assert_fail "読み方の決まっていない列を誤検知した" "$BAD"
else
  assert_ok "読み方の決まっていない列は対象外"
fi

cat > "$WORK/good/0001_init.sql" <<'EOF'
CREATE TABLE some_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id UUID
);
CREATE INDEX some_log_occurred_idx ON some_log (occurred_at DESC);
CREATE INDEX some_log_actor_occurred_idx ON some_log (actor_id, occurred_at DESC);
CREATE TRIGGER some_log_no_update_delete
  BEFORE UPDATE OR DELETE ON some_log
  FOR EACH ROW EXECUTE FUNCTION some_log_immutable();
EOF
GOOD="$(find_unindexed_log_columns "$WORK/good")"
if [ -z "$GOOD" ]; then
  assert_ok "索引がそろった fixture は誤検知しない"
else
  assert_fail "索引があるのに検知した" "$GOOD"
fi

cat > "$WORK/notlog/0001_init.sql" <<'EOF'
CREATE TABLE just_a_table (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  actor_id UUID
);
EOF
NOTLOG="$(find_unindexed_log_columns "$WORK/notlog")"
if [ -z "$NOTLOG" ]; then
  assert_ok "append-only でない表は対象外（印はトリガー）"
else
  assert_fail "append-only でない表を検知した" "$NOTLOG"
fi

cat > "$WORK/later/0001_init.sql" <<'EOF'
CREATE TABLE some_log (
  id UUID PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX some_log_occurred_idx ON some_log (occurred_at DESC);
CREATE TRIGGER some_log_no_update_delete
  BEFORE UPDATE OR DELETE ON some_log
  FOR EACH ROW EXECUTE FUNCTION some_log_immutable();
EOF
cat > "$WORK/later/0002_add_actor.sql" <<'EOF'
ALTER TABLE some_log ADD COLUMN actor_id UUID;
EOF
LATER="$(find_unindexed_log_columns "$WORK/later")"
if grep -qx 'some_log.actor_id' <<<"$LATER"; then
  assert_ok "後から足した列の索引欠けも検知する"
else
  assert_fail "ALTER TABLE ADD COLUMN で足した列を見ていない" "$LATER"
fi

if [ "$fail" -eq 0 ]; then
  echo "ALL PASSED"
  exit 0
fi
echo "FAILED"
exit 1
