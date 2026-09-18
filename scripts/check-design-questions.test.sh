#!/usr/bin/env bash
# WHY: 2026-09-06〜07 の点検で見つけた実害は、どれも「作る前に一言聞いていれば防げた」ものだった
#      （1 MB の入力・12,000 件で消せない施設・50 人で切れる一覧・パスワードだけで書けるマスタ）。
#      点検で見つけると、migration をもう 1 本書き、既存行を確認し、テストを足し、
#      ルールブックに行を足すことになる。作る前に 5 分聞けば最初から入っている。
#
#      「聞いたかどうか」は機械には分からないので、**答えを残したかどうか**を見る。
#      新しいテーブルを作る migration には `-- design:` の行を求める
#      （docs/agents/design-questions.md の質問に対する答え、または答えを書いた場所への参照）。
#
#   (a) baseline より新しい migration が CREATE TABLE を含むなら `-- design:` がある
#   (b) `-- design:` の中身が空でない
#   (c) 内部用の表は EXEMPT に理由つきで書けば免除される
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
#   過去の migration は対象外（遡って直させない）。
#
# 実行: bash scripts/check-design-questions.test.sh
# 環境変数（テスト用注入ポイント）: DESIGN_MIGRATIONS_DIR / DESIGN_BASELINE
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS="${DESIGN_MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"
BASELINE="${DESIGN_BASELINE:-20260907000000}"

# 免除する表と理由（人が読む機能の表は免除しない）
EXEMPT_TABLES="schema_drift_log schema_baseline_snapshot"
EXEMPT_REASON="観測・検知の裏方の表。利用者の入力を持たず、画面にも出ない"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

find_missing_design_note() {
  node -e '
const fs = require("fs")
const path = require("path")
const dir = process.argv[1]
const baseline = process.argv[2]
const exempt = new Set((process.argv[3] || "").split(/\s+/).filter(Boolean))
if (!fs.existsSync(dir)) process.exit(0)

for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) {
  const stamp = (f.match(/^(\d+)/) ?? [])[1] ?? "0"
  if (stamp <= baseline) continue
  const raw = fs.readFileSync(path.join(dir, f), "utf8")
  const body = raw.replace(/--[^\n]*/g, " ")

  const tables = []
  for (const m of body.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    const t = m[1].toLowerCase()
    if (!exempt.has(t)) tables.push(t)
  }
  if (tables.length === 0) continue

  const note = raw.split("\n").find((l) => /^--\s*design:/.test(l.trim()))
  if (!note) {
    console.log(`${f}: 新しい表（${[...new Set(tables)].join(", ")}）を作るのに -- design: の行が無い`)
  } else if (!note.replace(/^--\s*design:/, "").trim()) {
    console.log(`${f}: -- design: の中身が空`)
  }
}
' "$1" "$2" "$3"
}

echo "=== scenario 1: 実態の migration に design の記録漏れが無い ==="
OUT="$(find_missing_design_note "$MIGRATIONS" "$BASELINE" "$EXEMPT_TABLES")"
if [ -z "$OUT" ]; then
  assert_ok "記録漏れなし（baseline $BASELINE より新しい分）"
else
  assert_fail "新しい表を作るのに設計時の答えが残っていない" "$OUT
      docs/agents/design-questions.md の質問に人が答えてから、その答えを書く。例:
      -- design: 1 行あたり最大 1,000 文字（用途欄）。1 施設あたり数千件を想定。
      --         読めるのは施設メンバーと admin、書けるのは writer（aal2 必須）。
      --         施設削除で消える。拒否は access_denials に残す。外部送信なし。"
fi

echo "=== scenario 2: 免除する表の理由が書いてある ==="
if [ -n "$EXEMPT_REASON" ]; then
  assert_ok "免除の理由がある（${EXEMPT_TABLES}）"
else
  assert_fail "免除する表があるのに理由が無い"
fi

echo "=== scenario 3: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/m"

cat > "$WORK/m/20260908000001_new_table_without_note.sql" <<'EOF'
CREATE TABLE memos (
  id UUID PRIMARY KEY,
  body TEXT NOT NULL
);
EOF
cat > "$WORK/m/20260908000002_empty_note.sql" <<'EOF'
-- design:
CREATE TABLE notes (id UUID PRIMARY KEY);
EOF
cat > "$WORK/m/20260908000003_with_note.sql" <<'EOF'
-- design: 本文は 1,000 文字まで。1 施設あたり数千件。読み書きは施設メンバー（aal2）。
--         施設削除で消える。外部送信なし。
CREATE TABLE tips (id UUID PRIMARY KEY, body TEXT NOT NULL);
EOF
cat > "$WORK/m/20260908000004_exempt_table.sql" <<'EOF'
CREATE TABLE schema_drift_log (id UUID PRIMARY KEY);
EOF
cat > "$WORK/m/20260908000005_no_table.sql" <<'EOF'
ALTER TABLE tips ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
EOF
cat > "$WORK/m/20260101000000_old_table.sql" <<'EOF'
CREATE TABLE ancient (id UUID PRIMARY KEY);
EOF
cat > "$WORK/m/20260908000006_comment_only.sql" <<'EOF'
-- 説明の中で CREATE TABLE example と書いただけ（実際の DDL ではない）
SELECT 1;
EOF

OUT="$(find_missing_design_note "$WORK/m" "$BASELINE" "$EXEMPT_TABLES")"
for needle in 'new_table_without_note' 'empty_note'; do
  if grep -q "$needle" <<<"$OUT"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle" "$OUT"; fi
done
for needle in 'with_note' 'exempt_table' 'no_table' 'old_table' 'comment_only'; do
  if grep -q "$needle" <<<"$OUT"; then assert_fail "誤検知: $needle" "$OUT"; else assert_ok "誤検知しない: $needle"; fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
