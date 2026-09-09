#!/bin/bash
# WHY: docs/agents/release-safety-runbook.md（issue #757 の 13・25）の規約を migration ファイルで機械的に固定する。
#   (a) 2026-09-07 以降の migration（ファイル名のタイムスタンプが BASELINE より大きい）は
#       先頭付近に `-- release-order: db-first` か `-- release-order: app-first` を持つ
#   (b) 同じく `-- ROLLBACK:` を持つ（2026-09-06 の migration から始めた規約を必須化）
#   (c) 契約を縮める DDL（drop column / drop table / rename / alter column type / set not null / drop function）を
#       含む migration は `-- contract:` を持つ（旧アプリがいつから参照しなくなったかを書く）
#   (d) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#   既存の migration は baseline より古いので対象外（過去の PR を書き換えない）。
#
# 実行: bash scripts/check-migration-release-safety.test.sh
# 環境変数（テスト用注入ポイント）: MIGRATIONS_DIR / RELEASE_SAFETY_BASELINE（既定 20260906999999）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$REPO_ROOT/supabase/migrations}"
BASELINE="${RELEASE_SAFETY_BASELINE:-20260906999999}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# コメント行を除いた本文を返す
sql_body() { grep -v -E '^[[:space:]]*--' "$1" || true; }

has_contract_ddl() {
  sql_body "$1" | grep -i -q -E 'drop[[:space:]]+column|drop[[:space:]]+table|rename[[:space:]]+(column|to)|alter[[:space:]]+column[[:space:]]+[^ ]+[[:space:]]+(set[[:space:]]+data[[:space:]]+)?type|set[[:space:]]+not[[:space:]]+null|drop[[:space:]]+function'
}

# 検査本体。$1=migrations ディレクトリ $2=baseline。末尾行に violations=N
check_migrations() {
  local dir="$1" baseline="$2" violations=0 f name ts
  for f in "$dir"/*.sql; do
    [ -e "$f" ] || continue
    name="$(basename "$f")"
    ts="${name%%_*}"
    case "$ts" in ''|*[!0-9]*) continue ;; esac
    [ "$ts" -gt "$baseline" ] || continue
    if ! grep -q -E '^-- release-order: (db-first|app-first)$' "$f"; then
      echo "    release-order: [$name] '-- release-order: db-first|app-first' が無い"
      violations=$((violations+1))
    fi
    if ! grep -q -E '^-- ROLLBACK:' "$f"; then
      echo "    rollback: [$name] '-- ROLLBACK:' が無い"
      violations=$((violations+1))
    fi
    if has_contract_ddl "$f" && ! grep -q -E '^-- contract:' "$f"; then
      echo "    contract: [$name] 契約を縮める DDL があるのに '-- contract:' が無い"
      violations=$((violations+1))
    fi
  done
  echo "violations=$violations"
}

echo "=== scenario 1: 実態の migration（baseline より新しいもの）に違反が無い ==="
RESULT="$(check_migrations "$MIGRATIONS_DIR" "$BASELINE")"
NEWER="$(ls "$MIGRATIONS_DIR"/*.sql 2>/dev/null | awk -F/ '{print $NF}' | awk -F_ -v b="$BASELINE" '$1 > b' | wc -l | tr -d ' ')"
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=0" ]; then
  assert_ok "違反なし（対象 ${NEWER} 本）"
else
  assert_fail "違反あり" "$RESULT"
fi

echo "=== scenario 2: fixture で違反を検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cat > "$WORK/20270101000001_good_expand.sql" <<'EOF'
-- release-order: db-first
ALTER TABLE t ADD COLUMN c TEXT;
-- ROLLBACK: ALTER TABLE t DROP COLUMN c;
EOF
cat > "$WORK/20270101000002_good_contract.sql" <<'EOF'
-- release-order: app-first
-- contract: PR #1 以降のアプリは c を参照しない
ALTER TABLE t DROP COLUMN c;
-- ROLLBACK: ALTER TABLE t ADD COLUMN c TEXT;
EOF
cat > "$WORK/20270101000003_missing_order.sql" <<'EOF'
ALTER TABLE t ADD COLUMN d TEXT;
-- ROLLBACK: ALTER TABLE t DROP COLUMN d;
EOF
cat > "$WORK/20270101000004_missing_rollback.sql" <<'EOF'
-- release-order: db-first
ALTER TABLE t ADD COLUMN e TEXT;
EOF
cat > "$WORK/20270101000005_contract_without_note.sql" <<'EOF'
-- release-order: app-first
DROP FUNCTION f(uuid);
-- ROLLBACK: CREATE FUNCTION f(uuid) ...
EOF
cat > "$WORK/20270101000006_comment_only_mention.sql" <<'EOF'
-- release-order: db-first
-- この migration は drop column しない（コメントに書いてあるだけ）
ALTER TABLE t ADD COLUMN g TEXT;
-- ROLLBACK: ALTER TABLE t DROP COLUMN g;
EOF
cat > "$WORK/20260101000001_old_ignored.sql" <<'EOF'
DROP TABLE legacy;
EOF
RESULT="$(check_migrations "$WORK" "$BASELINE")"
EXPECTED=3
if [ "$(printf '%s\n' "$RESULT" | tail -n1)" = "violations=$EXPECTED" ]; then
  assert_ok "違反 ${EXPECTED} 件をちょうど検知"
else
  assert_fail "違反件数が期待（${EXPECTED}）と異なる" "$RESULT"
fi
for needle in 'release-order: \[20270101000003_missing_order.sql\]' 'rollback: \[20270101000004_missing_rollback.sql\]' 'contract: \[20270101000005_contract_without_note.sql\]'; do
  if printf '%s\n' "$RESULT" | grep -qE "$needle"; then assert_ok "検知: $needle"; else assert_fail "検知できない: $needle"; fi
done
if printf '%s\n' "$RESULT" | grep -q -e 'good_' -e 'comment_only' -e 'old_ignored'; then
  assert_fail "正常・コメントのみ・baseline 以前を誤検知" "$RESULT"
else
  assert_ok "正常な migration・コメント内の言及・baseline 以前は誤検知しない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
