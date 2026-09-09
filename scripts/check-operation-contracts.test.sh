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
#   8. 語彙違反（直接書き込み・認可・危険度・操作・状態の 5 列すべて）
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

echo "=== scenario 8: 語彙違反（5 列すべて） ==="
# WHY(認可・操作・状態も見る): 認可の語だけは**掃き側（統合テスト）が期待値を導く元**なので、
#      語彙から外れた語を書かれると、その行は**一度も実測されないまま緑**になる。
#      2026-09-09 の変異計測（CM-008）で、認可・操作・状態の 3 列は
#      判定を外しても緑のままだと分かったので、5 列すべてをここで留める。
DIR="$(make_fixture vocabulary)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | たぶん許可 | だれでも | ものすごく高い | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |' \
  '| O-030 | widgets | さくじょ | `POST /api/widgets` | 禁止 | 施設 writer | 低 | たぶん実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "bad-direct-write: O-010" "直接書き込みの語彙違反を検知"
assert_contains "$OUT" "bad-risk: O-010" "危険度の語彙違反を検知"
assert_contains "$OUT" "bad-authorization: O-010 だれでも" "認可の語彙違反を検知"
assert_contains "$OUT" "掃き側に期待値がある語だけを使う" "なぜ 4 語しか使えないかを伝える"
assert_contains "$OUT" "bad-operation: O-030 さくじょ" "操作の語彙違反を検知"
assert_contains "$OUT" "bad-state: O-030 たぶん実装済み" "状態の語彙違反を検知"
assert_not_contains "$OUT" "bad-authorization: O-020" "語彙どおりの行は出さない"

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

echo "=== scenario 11: 状態を「計画」に変えても違反が消えない ==="
# WHY(2026-09-10): 以前は state が「実装済み」でない行を丸ごと continue で飛ばしていたため、
#      **状態の 1 語を書き換えるだけ**で権限違反も直接書き込みも入口も検査されなくなった。
#      さらにその行は「宣言あり」として逆向きの undeclared-privilege も抑えていたので、
#      違反が 1 件も出ない状態を宣言だけで作れた。状態は宣言、権限は実態。実態は消えない。
DIR="$(make_fixture planned-suppression)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 禁止 | 施設 writer | 低 | 計画 |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` / `POST /api/gizmos` | 禁止 | 施設 writer | 高 | 実装済み |'
OUT="$(run_on "$DIR")"
assert_contains "$OUT" "unimplemented-but-granted: O-010 widgets.insert" "状態が計画でも実権限があれば検知"
assert_contains "$OUT" "unimplemented-but-written: O-010 widgets.insert" "状態が計画でもアプリが書いていれば検知"
assert_contains "$OUT" "unimplemented-but-live: O-010 POST /api/widgets" "状態が計画でも入口が開いていれば検知"
assert_not_contains "$OUT" "violations=0" "違反 0 件にならない"
# 二重に出さない（行はあるので「契約に行が無い」ではない）
assert_not_contains "$OUT" "undeclared-privilege: widgets.insert" "行がある表を「行が無い」とは言わない"

echo "=== scenario 12: 「対象外」でも実態が無ければ黙る（対照） ==="
# 常に鳴る実装になっていないことを見る。gizmos は権限もアプリの書き込みも無い
DIR="$(make_fixture planned-clean)"
write_catalog "$DIR" \
  '| O-010 | widgets | INSERT | `POST /api/widgets` | 許可 | 施設 writer | 低 | 実装済み |' \
  '| O-020 | gizmos | INSERT | `rpc:create_gizmo_atomic` | 禁止 | 施設 writer | 高 | 対象外 |'
OUT="$(run_on "$DIR")"
assert_not_contains "$OUT" "unimplemented-but-granted" "権限が無ければ言わない"
assert_not_contains "$OUT" "unimplemented-but-written" "書いていなければ言わない"
# rpc: の入口は実在するので「開いている」とは言う（道があることは事実）
assert_contains "$OUT" "unimplemented-but-live: O-020 rpc:create_gizmo_atomic" "実在する RPC は開いていると言う"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
