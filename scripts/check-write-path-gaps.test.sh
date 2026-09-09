#!/usr/bin/env bash
# WHY(E-056 / E-057): `scripts/lib/check-write-path-gaps.mjs` の回帰テスト。
#      この検査は**「DB は許すのにアプリに道が無い」**を数える。逆向き（アプリに道があるのに
#      DB が許さない）は `check-rls-grant-gaps.test.sh` の担当で、こちらはその裏側。
#
#      2026-09-08（E-056・発注と返却）と 2026-09-09（E-057・消耗品）に、
#      **2 日で 2 回、別々の表で同じ形**が見つかった。1 件ずつ直していたので、
#      同じ型が他の表にも残っていることを誰も数えていなかった。
#
#      検査そのものが空振りすると**違反ゼロで合格に見える**ので、次を固定する:
#
#   1. 実態に違反が無い
#   2. 宣言していない隙間を検知する（RED 方向）
#   3. 表名が変数の `.from()` を「アプリは書いていない」と読まず、宣言を要求する（C-040）
#   4. 宣言だけ残った行（道ができた・権限が剥がれた）を検知する
#   5. 上限を超えた・上限が無い、のどちらも検知する（ratchet）
#   6. 正しい fixture では 1 件も出さない（誤検知しない）
#   7. 片側でも走査結果が空なら**違反として落ちる**（fail-open 防止）
#
# 実行: bash scripts/check-write-path-gaps.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENGINE="$SCRIPT_DIR/lib/check-write-path-gaps.mjs"

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

run_on() { WRITE_PATH_GAPS_ROOT="$1" node "$ENGINE" 2>&1; }

# $1=fixture 名, $2=登録簿の JSON。widgets は DB が insert/update/delete を許す表
make_fixture() {
  local dir="$WORK_DIR/$1"
  mkdir -p "$dir/supabase/migrations" "$dir/src/lib"
  cat > "$dir/supabase/migrations/20260101000000_seed.sql" <<'SQL'
create table public.widgets (id uuid primary key);
alter table widgets enable row level security;
grant select, insert, update, delete on table public.widgets to authenticated;
create policy "widgets_all" on widgets for all to authenticated using (true) with check (true);
create table public.gizmos (id uuid primary key);
alter table gizmos enable row level security;
grant select, insert on table public.gizmos to authenticated;
create policy "gizmos_all" on gizmos for all to authenticated using (true) with check (true);
SQL
  printf "%s" "$2" > "$dir/scripts-registry.json"
  mkdir -p "$dir/scripts/lib"
  mv "$dir/scripts-registry.json" "$dir/scripts/lib/write-path-registry.json"
  echo "$dir"
}

BASE_SCAN='"migrationsDir":"supabase/migrations","scan":{"roots":["src"],"extensions":[".ts"],"excludeDirs":["__tests__"]}'

echo "=== scenario 1: 実態に違反が無い ==="
OUT="$(cd "$REPO_ROOT" && node "$ENGINE" 2>&1)"
CODE=$?
assert_contains "$OUT" "violations=0" "違反なし"
if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi

echo "=== scenario 2: 宣言していない隙間を検知する（RED 方向） ==="
# アプリは widgets を insert するだけ。update / delete / gizmos.insert に道が無い
DIR="$(make_fixture undeclared "{$BASE_SCAN,\"declaredGaps\":{},\"maxGaps\":9}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const create = (db) => db.from('widgets').insert({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "undeclared-gap: widgets.update" "更新の道が無いのを検知"
assert_contains "$OUT" "undeclared-gap: widgets.delete" "削除の道が無いのを検知"
assert_contains "$OUT" "undeclared-gap: gizmos.insert" "別の表の隙間も検知"
assert_not_contains "$OUT" "undeclared-gap: widgets.insert" "道のある向きは出さない"

echo "=== scenario 3: 表名が変数の .from() は宣言を要求する（C-040） ==="
DIR="$(make_fixture dynamic "{$BASE_SCAN,\"declaredGaps\":{\"widgets.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\",\"widgets.delete\":\"削除の道は製品に無い。使っていない権限なので剥がす候補\",\"gizmos.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\"},\"maxGaps\":9}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const update = (db, table) => db.from(table).update({ status: 'cancelled' })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "unresolved-from: src/lib/repo.ts" "解析できない呼び出しを検知"
assert_contains "$OUT" "undeclared-gap: widgets.update" "宣言が無いので更新は隙間のまま"

# 宣言すれば隙間が埋まる（「アプリは書いていない」と誤読しない）
DIR2="$(make_fixture dynamic-ok "{$BASE_SCAN,\"dynamicCallSites\":{\"src/lib/repo.ts\":{\"tables\":[\"widgets\"],\"verbs\":[\"update\"],\"reason\":\"表名を引数で受け取り、3 表の status を書き換える\"}},\"declaredGaps\":{\"widgets.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\",\"widgets.delete\":\"削除の道は製品に無い。使っていない権限なので剥がす候補\",\"gizmos.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\"},\"maxGaps\":9}")"
cp "$DIR/src/lib/repo.ts" "$DIR2/src/lib/repo.ts"
OUT="$(run_on "$DIR2")"
assert_not_contains "$OUT" "unresolved-from" "宣言した呼び出しは出さない"
assert_not_contains "$OUT" "undeclared-gap: widgets.update" "宣言が隙間を埋める"
assert_contains "$OUT" "violations=0" "宣言が揃えば違反なし"

echo "=== scenario 4: 宣言だけ残った行を検知する ==="
DIR="$(make_fixture stale "{$BASE_SCAN,\"declaredGaps\":{\"widgets.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\",\"widgets.update\":\"更新の道は製品に無い。使っていない権限なので剥がす候補\",\"widgets.delete\":\"削除の道は製品に無い。使っていない権限なので剥がす候補\",\"gizmos.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\",\"gadgets.delete\":\"もう存在しない表についての宣言（DB が許していない）\"},\"maxGaps\":9}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const create = (db) => db.from('widgets').insert({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "stale-gap: widgets.insert" "道ができた宣言を検知"
assert_contains "$OUT" "stale-gap: gadgets.delete" "DB が許していない宣言を検知"
assert_not_contains "$OUT" "stale-gap: widgets.update" "まだ隙間のままの宣言は出さない"

echo "=== scenario 5: ratchet（上限超過と書き忘れ） ==="
DIR="$(make_fixture overmax "{$BASE_SCAN,\"declaredGaps\":{\"widgets.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\",\"widgets.update\":\"更新の道は製品に無い。使っていない権限なので剥がす候補\",\"widgets.delete\":\"削除の道は製品に無い。使っていない権限なので剥がす候補\",\"gizmos.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\"},\"maxGaps\":2}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const touch = (db) => db.from('gizmos').update({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "over-max:" "上限超過を検知"

DIR="$(make_fixture nomax "{$BASE_SCAN,\"declaredGaps\":{}}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const create = (db) => db.from('widgets').insert({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "no-max:" "上限の書き忘れを検知"

echo "=== scenario 6: 正しい fixture では 1 件も出さない ==="
DIR="$(make_fixture clean "{$BASE_SCAN,\"declaredGaps\":{\"gizmos.insert\":\"作成は RPC が行うのでクライアントの権限は余剰\"},\"maxGaps\":1}")"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const create = (db) => db.from('widgets').insert({ id: 1 })
export const edit = (db) => db.from('widgets').update({ id: 1 })
export const remove = (db) => db.from('widgets').delete()
TS
# __tests__ の中の書き込みは道として数えない（テストだけが書ける表を「道がある」と読まない）
mkdir -p "$DIR/src/lib/__tests__"
cat > "$DIR/src/lib/__tests__/repo.ts" <<'TS'
export const seed = (db) => db.from('gizmos').insert({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "violations=0" "誤検知なし"
assert_contains "$OUT" "gaps=1" "隙間は 1 件だけ"

echo "=== scenario 7: 片側でも空なら落ちる（fail-open 防止） ==="
DIR="$(make_fixture noapp "{$BASE_SCAN,\"declaredGaps\":{},\"maxGaps\":9}")"
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "アプリ側の書き込みを 1 つも見つけられなかった" "アプリ側が空なら落ちる"

DIR="$(make_fixture nodb "{\"migrationsDir\":\"empty\",\"scan\":{\"roots\":[\"src\"],\"extensions\":[\".ts\"]},\"declaredGaps\":{},\"maxGaps\":9}")"
mkdir -p "$DIR/empty"
cat > "$DIR/src/lib/repo.ts" <<'TS'
export const create = (db) => db.from('widgets').insert({ id: 1 })
TS
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "DB 側で書ける表を 1 つも見つけられなかった" "DB 側が空なら落ちる"

echo "=== scenario 8: 登録簿が無い導入先は対象 0 件で通る ==="
DIR="$WORK_DIR/noregistry"
mkdir -p "$DIR"
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "登録簿が無いので対象 0 件" "登録簿の無い導入先は黙って通る"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
