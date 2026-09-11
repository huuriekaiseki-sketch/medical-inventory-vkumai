#!/usr/bin/env bash
# WHY: issue #757 の 18（マイグレーションの互換性）。DDL には「一瞬で終わるもの」と
#      「その表への書き込みを止めるもの」があり、見た目では区別できない。
#      2026-09-07 に索引 10 本を足す migration（20260907000003）を書いたとき、
#      ローカルでは 36,000 行で 40 ms だったが、本番のデータ量では作成中ずっと書き込みが止まる。
#      「ローカルで速かった」は本番で安全な証拠にならない（#757-19 の教訓と同じ形）。
#
#      止まる時間の見積もりは人にしか書けないので、機械は**書いたかどうか**だけを見る。
#      ロックを取る DDL を含む migration には `-- lock:` の 1 行を必須にする。
#
#   対象の DDL（PostgreSQL でその表への書き込みが止まるもの）:
#     - CREATE INDEX（CONCURRENTLY 無し）
#     - ALTER TABLE ... ADD CONSTRAINT ... CHECK（NOT VALID 無し。既存行を全部読む）
#     - ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY（NOT VALID 無し。参照先も読む）
#     - ALTER TABLE ... ALTER COLUMN ... TYPE（表を書き直す）
#
#   (a) baseline より新しい migration が上の DDL を含むなら `-- lock:` がある
#   (b) `-- lock:` の行が空でない（「-- lock:」だけは不可）
#   (c) CONCURRENTLY / NOT VALID を使っていれば注記は要らない（安全な書き方をした証拠）
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
#   baseline より前の migration は対象外（過去の分を遡って直させない。#757-13/25 の
#   release-order 注記と同じ考え方）。
#
# 実行: bash scripts/check-migration-lock-safety.test.sh
# 環境変数（テスト用注入ポイント）: LOCK_SAFETY_MIGRATIONS_DIR / LOCK_SAFETY_BASELINE
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS="${LOCK_SAFETY_MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"
# この時刻より新しい migration に注記を求める（2026-09-07 のルール導入時点）
BASELINE="${LOCK_SAFETY_BASELINE:-20260907000000}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

find_missing_lock_note() {
  node -e '
const fs = require("fs")
const path = require("path")
const dir = process.argv[1]
const baseline = process.argv[2]
if (!fs.existsSync(dir)) process.exit(0)

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const stamp = (f.match(/^(\d+)/) ?? [])[1] ?? "0"
  if (stamp <= baseline) continue
  const raw = fs.readFileSync(path.join(dir, f), "utf8")
  // コメントを落とした本文だけを見る（注記の例文を DDL と誤認しないため）
  const body = raw.replace(/--[^\n]*/g, " ")
  const n = body.replace(/\s+/g, " ").toLowerCase()

  const hits = []
  // CREATE INDEX（CONCURRENTLY 無し）
  for (const m of n.matchAll(/create\s+(unique\s+)?index\s+(concurrently\s+)?/g)) {
    if (!m[2]) hits.push("CREATE INDEX（CONCURRENTLY 無し）")
  }
  // ADD CONSTRAINT ... CHECK / FOREIGN KEY（NOT VALID 無し）
  for (const m of n.matchAll(/add\s+constraint\s+[a-z0-9_\"]+\s+(check|foreign\s+key)[^;]*/g)) {
    if (!/not\s+valid/.test(m[0])) hits.push(`ADD CONSTRAINT ${m[1].toUpperCase()}（NOT VALID 無し）`)
  }
  // 列の型変更
  if (/alter\s+column\s+[a-z0-9_\"]+\s+type\s/.test(n)) hits.push("ALTER COLUMN ... TYPE")

  if (hits.length === 0) continue
  const note = raw.split("\n").find((l) => /^--\s*lock:/.test(l.trim()))
  if (!note) {
    console.log(`${f}: ${[...new Set(hits)].join(" / ")} があるのに -- lock: の注記が無い`)
  } else if (!note.replace(/^--\s*lock:/, "").trim()) {
    console.log(`${f}: -- lock: の中身が空`)
  }
}
' "$1" "$2"
}

echo "=== scenario 1: 実態の migration に注記漏れが無い ==="
OUT="$(find_missing_lock_note "$MIGRATIONS" "$BASELINE")"
if [ -z "$OUT" ]; then
  assert_ok "注記漏れなし（baseline $BASELINE より新しい分）"
else
  assert_fail "ロックを取る DDL に -- lock: が無い" "$OUT
      書き方の例:
      -- lock: 対象表への書き込みが作成中止まる（case_order_items ほか 6 表。ローカル 36,000 行で 40 ms。
      --       本番規模は未計測なので、利用の少ない時間帯に当てる）"
fi

echo "=== scenario 2: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/m"

cat > "$WORK/m/20260908000001_index_without_note.sql" <<'EOF'
CREATE INDEX idx_a ON t (col);
EOF
cat > "$WORK/m/20260908000002_check_without_not_valid.sql" <<'EOF'
ALTER TABLE t ADD CONSTRAINT t_positive CHECK (n > 0);
EOF
cat > "$WORK/m/20260908000003_empty_note.sql" <<'EOF'
-- lock:
CREATE INDEX idx_b ON t (col);
EOF
cat > "$WORK/m/20260908000004_ok_note.sql" <<'EOF'
-- lock: 作成中は t への書き込みが止まる（実測 40 ms / 36,000 行）
CREATE INDEX idx_c ON t (col);
EOF
cat > "$WORK/m/20260908000005_safe_forms.sql" <<'EOF'
CREATE INDEX CONCURRENTLY idx_d ON t (col);
ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (p) REFERENCES p (id) NOT VALID;
EOF
cat > "$WORK/m/20260101000000_old_one.sql" <<'EOF'
CREATE INDEX idx_old ON t (col);
EOF
cat > "$WORK/m/20260908000006_comment_only.sql" <<'EOF'
-- 説明の中で CREATE INDEX idx_x ON t (col); と書いただけ（実際の DDL ではない）
SELECT 1;
EOF

OUT="$(find_missing_lock_note "$WORK/m" "$BASELINE")"
for needle in 'index_without_note' 'check_without_not_valid' 'empty_note'; do
  if grep -q "$needle" <<<"$OUT"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle" "$OUT"; fi
done
for needle in 'ok_note' 'safe_forms' 'old_one' 'comment_only'; do
  if grep -q "$needle" <<<"$OUT"; then assert_fail "誤検知: $needle" "$OUT"; else assert_ok "誤検知しない: $needle"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
