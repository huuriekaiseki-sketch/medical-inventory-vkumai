#!/usr/bin/env bash
# WHY(2026-09-09): `scripts/lib/check-operation-contracts.mjs` の回帰テスト。
#      操作の契約（O-xxx）は**宣言**なので、実態と突き合わせていなければただのメモになる
#      （C-010: 人が書いた印を実態と突き合わせていない）。
#      この検査が空振りすると**違反ゼロで合格に見える**ので、次を固定する:
#
#   1. 実態に違反が無い
#   2. 「禁止」と宣言したのに DB がクライアントに許している（RPC だけという約束が破れた）
#   3. 「禁止」と宣言したのにアプリが直接書いている
#   4. 「許可」と宣言したのに権限が無い／アプリが書いていない
#   5. DB が許しているのに契約に行が無い（逆向き）
#   6. 入口が実在しない（route / RPC）
#   7. route が攻撃表に載っていない
#   8. 語彙違反（直接書き込み・危険度）
#   9. 行を 1 つも読めなければ**違反として落ちる**（fail-open 防止）
#
# 実行: bash scripts/check-operation-contracts.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
ENGINE="$SCRIPT_DIR/lib/check-operation-contracts.mjs"

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

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_on() { OPERATION_CONTRACTS_ROOT="$1" node "$ENGINE" 2>&1; }

# $1=fixture 名。widgets（3 動詞とも許可）と gizmos（INSERT だけ、RPC 経由）を持つミニリポジトリ
make_fixture() {
  local dir="$WORK/$1"
  mkdir -p "$dir/supabase/migrations" "$dir/scripts/lib" "$dir/docs/agents" "$dir/e2e" "$dir/src/lib" \
    "$dir/src/app/api/widgets" "$dir/src/app/api/gizmos"

  cat > "$dir/supabase/migrations/20260101000000_seed.sql" <<'SQL'
create table public.widgets (id uuid primary key);
alter table widgets enable row level security;
grant select, insert on table public.widgets to authenticated;
create policy "widgets_all" on widgets for all to authenticated using (true) with check (true);
create table public.gizmos (id uuid primary key);
alter table gizmos enable row level security;
grant select on table public.gizmos to authenticated;
create policy "gizmos_select" on gizmos for select to authenticated using (true);
create or replace function create_gizmo_atomic() returns void language sql as $$ select 1 $$;
SQL

  cat > "$dir/scripts/lib/write-path-registry.json" <<'JSON'
{
  "migrationsDir": "supabase/migrations",
  "scan": { "roots": ["src"], "extensions": [".ts"], "excludeDirs": ["__tests__"] },
  "declaredGaps": {},
  "maxGaps": 9
}
JSON

  printf "export const POST = async () => null\n" > "$dir/src/app/api/widgets/route.ts"
  printf "export const POST = async () => null\n" > "$dir/src/app/api/gizmos/route.ts"
  # route.ts は `export async function POST` の形しか拾わないので書き直す
  printf "export async function POST() { return null }\n" > "$dir/src/app/api/widgets/route.ts"
  printf "export async function POST() { return null }\n" > "$dir/src/app/api/gizmos/route.ts"
  printf "export const create = (db) => db.from('widgets').insert({ id: 1 })\n" > "$dir/src/lib/repo.ts"
  printf "export const ATTACK_MATRIX = { '/api/widgets': {}, '/api/gizmos': {} }\n" > "$dir/e2e/api-attack-matrix.ts"
  echo "$dir"
}

# $1=fixture ディレクトリ, $2... = 表の行
write_catalog() {
  local dir="$1"; shift
  {
    echo '# 操作の契約（O-xxx）'
    echo
    echo '| ID | 対象 | 操作 | 入口 | 直接書き込み | 認可 | 危険度 | 状態 |'
    echo '| --- | --- | --- | --- | --- | --- | --- | --- |'
    for row in "$@"; do echo "$row"; done
  } > "$dir/docs/agents/operation-contracts.md"
}

echo "=== scenario 1: 実態に違反が無い ==="
OUT="$(cd "$REPO_ROOT" && node "$ENGINE" 2>&1)"
CODE=$?
assert_contains "$OUT" "violations=0" "違反なし"
if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi

echo "=== scenario 2: 正しい fixture は 1 件も出さない（誤検知しない） ==="
DIR="$(make_fixture clean)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "violations=0" "誤検知なし"
assert_contains "$OUT" "operations=2 直接書き込み禁止=1" "件数を数えている"

echo "=== scenario 3: 「禁止」なのに DB がクライアントに許している ==="
DIR="$(make_fixture forbidden-priv)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 禁止 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "forbidden-privilege: O-010 widgets.insert" "RPC だけという約束が破れているのを検知"
assert_contains "$OUT" "forbidden-direct-write: O-010 widgets.insert" "アプリが直接書いているのも検知"

echo "=== scenario 4: 「許可」なのに権限もアプリの道も無い ==="
DIR="$(make_fixture stale-allow)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 許可 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "missing-privilege: O-020 gizmos.insert" "権限が無いのに許可と宣言しているのを検知"
assert_contains "$OUT" "stale-direct-write: O-020 gizmos.insert" "アプリが書いていないのを検知"

echo "=== scenario 5: DB が許しているのに契約に行が無い（逆向き） ==="
DIR="$(make_fixture undeclared)"
write_catalog "$DIR" \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "undeclared-privilege: widgets.insert" "宣言の無い権限を検知"

echo "=== scenario 6: 入口が実在しない ==="
DIR="$(make_fixture missing-entry)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `PUT /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomik` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "missing-route: O-010 PUT /api/widgets" "export していないメソッドを検知"
assert_contains "$OUT" "missing-rpc: O-020 rpc:create_gizmo_atomik" "存在しない RPC を検知"

echo "=== scenario 7: route が攻撃表に載っていない ==="
DIR="$(make_fixture not-in-matrix)"
printf "export const ATTACK_MATRIX = { '/api/gizmos': {} }\n" > "$DIR/e2e/api-attack-matrix.ts"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "not-in-attack-matrix: O-010 POST /api/widgets" "攻撃表への載せ忘れを検知"
assert_not_contains "$OUT" "not-in-attack-matrix: O-020" "載っている入口は出さない"

echo "=== scenario 8: 語彙違反 ==="
DIR="$(make_fixture vocabulary)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | たぶん許可 | 施設 writer | ものすごく高い | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "bad-direct-write: O-010" "直接書き込みの語彙違反を検知"
assert_contains "$OUT" "bad-risk: O-010" "危険度の語彙違反を検知"

echo "=== scenario 9: 行を 1 つも読めなければ落ちる（fail-open 防止） ==="
DIR="$(make_fixture empty)"
printf '# 操作の契約\n\n表が壊れている\n' > "$DIR/docs/agents/operation-contracts.md"
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "契約の行を 1 つも読めなかった" "空の表で落ちる"

echo "=== scenario 10: 同じ操作を 2 行書いたら落ちる ==="
DIR="$(make_fixture duplicate)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-011 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "duplicate: O-011 widgets.insert" "同じ操作の重複を検知"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
