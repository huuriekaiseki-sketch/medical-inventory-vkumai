#!/usr/bin/env bash
# WHY(E-055): `scripts/lib/scan-rls-grant-gaps.mjs` の回帰テスト。
#      この検査は「権限はあるがポリシーが無い」＝**触れるが何も起きない道**を止める。
#      2026-09-08 に `facilities` の DELETE でそれが起き、実在する施設に
#      404「施設が見つかりません」を返していた（認可の問題なのに、そう読めない）。
#
#      検査そのものが空振りすると、**違反ゼロで合格に見える**（今日いちばん多く踏んだ型）。
#      次の 5 つを固定する:
#
#   1. 実態の migration に違反が無い
#   2. fixture で「権限はあるがポリシーが無い」をちょうど検知する（RED 方向）
#   3. fixture で「ポリシーはあるが権限が無い」も検知する（逆向き）
#   4. 正しい fixture では 1 件も出さない（誤検知しない）
#   5. 表を 1 つも見つけられなければ**違反として落ちる**（fail-open 防止）
#
# 実行: bash scripts/check-rls-grant-gaps.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCANNER="$SCRIPT_DIR/lib/scan-rls-grant-gaps.mjs"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected to find: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label"; echo "      unexpected: $needle"; echo "      actual: $haystack"; fail=1
  else echo "  OK: $label"; fi
}

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

run_on() { # $1=migration ディレクトリ
  RLS_GRANT_GAPS_DIR="$1" node "$SCANNER" 2>&1
}

echo "=== scenario 1: 実態の migration に違反が無い ==="
OUT="$(cd "$REPO_ROOT" && node "$SCANNER" 2>&1)"
CODE=$?
assert_contains "$OUT" "violations=0" "違反なし"
if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi

echo "=== scenario 2: 権限はあるがポリシーが無い（RED 方向）==="
BAD="$WORK_DIR/bad"
mkdir -p "$BAD"
cat > "$BAD/20260101000000_seed.sql" <<'SQL'
create table public.widgets (id uuid primary key);
alter table widgets enable row level security;
grant all on table public.widgets to anon, authenticated, service_role;
revoke all on widgets from anon;
create policy "widgets_select" on widgets for select to authenticated using (true);
SQL
OUT="$(run_on "$BAD")"
assert_contains "$OUT" "silent-noop: widgets DELETE" "DELETE の穴を検知"
assert_contains "$OUT" "silent-noop: widgets INSERT" "INSERT の穴も検知"
assert_contains "$OUT" "silent-noop: widgets UPDATE" "UPDATE の穴も検知"
assert_not_contains "$OUT" "silent-noop: widgets SELECT" "ポリシーのある SELECT は出さない"
assert_not_contains "$OUT" "widgets DELETE — anon" "REVOKE した anon は出さない"

echo "=== scenario 3: ポリシーはあるが権限が無い（逆向き）==="
REV="$WORK_DIR/reverse"
mkdir -p "$REV"
cat > "$REV/20260101000000_seed.sql" <<'SQL'
create table public.gadgets (id uuid primary key);
alter table gadgets enable row level security;
revoke all on table gadgets from anon, authenticated, service_role;
create policy "gadgets_write" on gadgets for all to authenticated using (true) with check (true);
SQL
OUT="$(run_on "$REV")"
assert_contains "$OUT" "unreachable-policy: gadgets SELECT" "届かないポリシーを検知"
assert_contains "$OUT" "unreachable-policy: gadgets DELETE" "FOR ALL は 4 コマンドすべてを覆う"

echo "=== scenario 4: 正しい fixture では 1 件も出さない ==="
GOOD="$WORK_DIR/good"
mkdir -p "$GOOD"
cat > "$GOOD/20260101000000_seed.sql" <<'SQL'
create table public.things (id uuid primary key);
alter table things enable row level security;
revoke all on table things from anon, authenticated, service_role;
grant select, insert on table things to authenticated;
create policy "things_select" on things for select to authenticated using (true);
create policy "things_insert" on things for insert to authenticated with check (true);
SQL
OUT="$(run_on "$GOOD")"
assert_contains "$OUT" "violations=0" "誤検知なし"

echo "=== scenario 5: 表が 1 つも無ければ違反として落ちる（fail-open 防止）==="
EMPTY="$WORK_DIR/empty"
mkdir -p "$EMPTY"
OUT="$(run_on "$EMPTY")"
CODE=$?
assert_contains "$OUT" "走査が壊れている" "空振りを違反として報告する"
if [ "$CODE" -ne 0 ]; then echo "  OK: exit ${CODE}（0 でない）"; else echo "  NG: 空振りなのに exit 0"; fail=1; fi

echo "=== scenario 6: 同じ migration 内の「外して付け直す」を出現順に読む ==="
REDO="$WORK_DIR/redo"
mkdir -p "$REDO"
cat > "$REDO/20260101000000_seed.sql" <<'SQL'
create table public.doodads (id uuid primary key);
alter table doodads enable row level security;
revoke all on table doodads from anon, authenticated, service_role;
grant select on table doodads to authenticated;
create policy "doodads_select" on doodads for select to authenticated using (true);
drop policy if exists "doodads_select" on doodads;
create policy "doodads_select" on doodads for select to authenticated using (is_admin());
SQL
OUT="$(run_on "$REDO")"
assert_contains "$OUT" "violations=0" "付け直したポリシーを「無い」と読まない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
