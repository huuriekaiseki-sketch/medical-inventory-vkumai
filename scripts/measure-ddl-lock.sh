#!/usr/bin/env bash
# WHY: issue #757 の 18（マイグレーションの互換性）。`-- lock:` の注記は 23 件あるが、
#      そこに書いてある「止まる / 止まらない」は**人が書いた見積もり**で、一度も実測していなかった。
#      `scripts/check-migration-lock-safety.test.sh` は注記の**有無**しか見ない（見積もりの中身は見ない）。
#      ここは見積もりの根拠になる数字を実際に測る側。
#
#      測るのは 2 つ。どちらか片方では意味が無い:
#        (1) **所要時間**（行数別）。ロックを保持する時間そのもの。「本番規模でどれだけ止まるか」
#        (2) **ロックを取るか**（対照つき）。時間が短いだけなのか、そもそも競合しないのかの区別
#
#      (2) の測り方には落とし穴が 4 つあり、全部踏んでから今の形になった（2026-09-18）:
#        - DDL を pg_sleep で保持して測ると、止めているのは DDL ではなく sleep（C-023）
#        - 書き手を DO ブロックで書くと**単一トランザクション**なので、書き手が先にロックを
#          握って DDL の側が待たされる（測る側と測られる側が逆）
#        - 書き手を DDL の後に起動すると、プロセスの起動順が結果を決める（C-045）
#        - `pg_stat_activity` は**トランザクション内でキャッシュされる**（PG15 以降）。
#          ループの中で `pg_stat_clear_snapshot()` を呼ばないと同じ古い姿を見続ける
#      いまの形は「書き手を先に起動 → SQL 側で DDL が active になるのを確認 → lock_timeout=1ms で
#      単発の書き込み」。時間ではなくエラーコードで判定するので、待ち時間の揺れに左右されない。
#
#      `lock_timeout` を 1ms にするのが肝。200ms にすると「DDL がそれより短ければ待ちきれて成功」
#      してしまい、**ロックを取ったかどうかではなく DDL の長さ**を見ることになる（実測で確認済み）。
#
# これは CI では回さない（時間がかかる。`measure-scale.sh` と同じ扱い）。
# test-matrix の「規模の実測」は節目に人が起動する。
#
# 使い方:
#   bash scripts/measure-ddl-lock.sh              # 既定 1,000,000 行
#   ROWS=10000000 bash scripts/measure-ddl-lock.sh
#
# 前提: `supabase start` 済み。結果は docs/agents/performance-baseline.md に追記する。
# 本番には絶対に向けない（DB_URL が localhost であることを確認する）。
set -uo pipefail

ROWS="${ROWS:-1000000}"

DB_URL="${DDL_LOCK_DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
case "$DB_URL" in
  *@127.0.0.1:*|*@localhost:*) ;;
  *)
    echo "measure-ddl-lock: ローカル以外のデータベースには向けられない: $DB_URL" >&2
    exit 1
    ;;
esac

# WHY: psql は手元に無いことが多い（PostgreSQL クライアントを別途入れていない）。
#      ローカルのデータベースはコンテナで動いているので、その中の psql を使う。
CONTAINER="${DDL_LOCK_CONTAINER:-$(docker ps --filter 'name=supabase_db_' --format '{{.Names}}' | head -1)}"
if [ -z "$CONTAINER" ]; then
  echo "measure-ddl-lock: ローカルのデータベースが起動していない（supabase start）" >&2
  exit 1
fi

psql_q() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -q "$@"; }
psql_strict() { docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

cleanup() {
  psql_q -c "drop table if exists public.lock_probe" > /dev/null 2>&1
}
trap cleanup EXIT

echo "=== 準備: ${ROWS} 行の複製表を作る ==="
# WHY: 本物の業務表には入れない。行数を億単位まで振れるようにするため、
#      同じ形（主キー・施設 id・数値・テキスト）の使い捨ての表で測る。
#      列の数や索引の本数で係数は変わるので、**読むのは絶対値ではなく増え方**。
psql_strict > /dev/null <<SQL
drop table if exists public.lock_probe;
create table public.lock_probe (
  id bigserial primary key,
  facility_id uuid not null default gen_random_uuid(),
  amount integer not null default 0,
  note text
);
insert into public.lock_probe (amount, note)
select g, 'row-' || g from generate_series(1, ${ROWS}) g;
analyze public.lock_probe;
SQL
ACTUAL="$(psql_q -t -A -c 'select count(*) from public.lock_probe')"
if [ "$ACTUAL" != "$ROWS" ]; then
  echo "measure-ddl-lock: 行数が合わない（頼んだ ${ROWS} / 入った ${ACTUAL}）。測定を中止する" >&2
  exit 1
fi
echo "  ${ACTUAL} 行"

# ---------------------------------------------------------------------------
# (1) 所要時間 = ロックを保持する時間
# ---------------------------------------------------------------------------
echo
echo "=== (1) 所要時間（${ROWS} 行） ==="
timed() {
  local label="$1" ddl="$2" undo="$3" out t
  out="$(docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
        -c '\timing on' -c "$ddl" 2>&1)"
  t="$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' <<<"$out" | tail -1)"
  if [ -z "$t" ]; then
    printf '  %-46s %s\n' "$label" "測れなかった: $(head -2 <<<"$out" | tr '\n' ' ')"
  else
    printf '  %-46s %9s ms\n' "$label" "$t"
  fi
  [ -n "$undo" ] && psql_q -c "$undo" > /dev/null 2>&1
}

timed "CREATE INDEX" \
  "create index lp_idx on public.lock_probe (amount);" "drop index lp_idx"
timed "CREATE INDEX CONCURRENTLY（対照）" \
  "create index concurrently lp_idx_c on public.lock_probe (amount);" "drop index lp_idx_c"
timed "ADD CHECK（NOT VALID 無し。既存行を全部読む）" \
  "alter table public.lock_probe add constraint lp_chk check (amount >= 0);" \
  "alter table public.lock_probe drop constraint lp_chk"
timed "ADD CHECK NOT VALID（対照）" \
  "alter table public.lock_probe add constraint lp_chk check (amount >= 0) not valid;" \
  "alter table public.lock_probe drop constraint lp_chk"
timed "ADD COLUMN NOT NULL DEFAULT 定数（対照）" \
  "alter table public.lock_probe add column c1 integer not null default 0;" \
  "alter table public.lock_probe drop column c1"
timed "ADD COLUMN NOT NULL DEFAULT 揮発関数" \
  "alter table public.lock_probe add column c2 uuid not null default gen_random_uuid();" \
  "alter table public.lock_probe drop column c2"
timed "ALTER COLUMN SET NOT NULL（全行スキャン）" \
  "alter table public.lock_probe alter column note set not null;" ""
timed "ALTER COLUMN TYPE（表を書き直す）" \
  "alter table public.lock_probe alter column amount type bigint;" ""

# ---------------------------------------------------------------------------
# (2) 書き込みが止まるか（時間ではなくエラーコードで判定する）
# ---------------------------------------------------------------------------
echo
echo "=== (2) 書き込みが止まるか ==="
blocked() {
  local label="$1" ddl="$2" pat="$3" undo="$4"
  local dlog wlog
  dlog="$(mktemp)"; wlog="$(mktemp)"

  # 書き手を**先に**起動して待機させる。待ちループは lock_probe に触れないのでロックを取らない。
  docker exec -i "$CONTAINER" psql -U postgres -d postgres -q > "$wlog" 2>&1 <<SQL &
do \$\$
declare deadline timestamptz := clock_timestamp() + interval '120 seconds';
begin
  while clock_timestamp() < deadline loop
    -- pg_stat_activity はトランザクション内でキャッシュされる（PG15 以降）。
    -- 消さないとループしても同じ古いスナップショットを見続ける。
    perform pg_stat_clear_snapshot();
    if exists (
      select 1 from pg_stat_activity
      where pid <> pg_backend_pid() and state = 'active' and query ilike '${pat}'
    ) then
      raise notice 'SAW_DDL';
      return;
    end if;
    perform pg_sleep(0.005);
  end loop;
  raise notice 'NO_DDL';
end \$\$;
set lock_timeout='1ms';
insert into public.lock_probe (amount, note) values (1, 'probe');
select 'WROTE_OK';
SQL
  local wpid=$!
  sleep 1   # 書き手が待機ループに入るまで（ここでの待ちは判定に影響しない）

  docker exec -i "$CONTAINER" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q \
    -c '\timing on' -c "$ddl" > "$dlog" 2>&1
  wait "$wpid" 2>/dev/null

  local ddlms verdict
  ddlms="$(sed -n 's/^Time: \([0-9.]*\) ms.*/\1/p' "$dlog" | tail -1)"
  if ! grep -q 'SAW_DDL' "$wlog"; then
    # WHY(C-025): DDL を見ていないなら、通ったことに意味は無い。「止まらない」と読ませない
    verdict='判定不能（DDL が走っているのを見られなかった）'
  elif grep -q 'lock timeout' "$wlog"; then
    verdict='止まる'
  elif grep -q 'WROTE_OK' "$wlog"; then
    verdict='止まらない'
  else
    verdict="判定不能（$(head -3 "$wlog" | tr '\n' ' ')）"
  fi
  printf '  %-46s DDL %9s ms / 書き込み: %s\n' "$label" "${ddlms:-?}" "$verdict"
  rm -f "$dlog" "$wlog"
  [ -n "$undo" ] && psql_q -c "$undo" > /dev/null 2>&1
}

blocked "CREATE INDEX" \
  "create index lp_idx on public.lock_probe (amount);" 'create index lp_idx%' "drop index lp_idx"
blocked "CREATE INDEX CONCURRENTLY（対照）" \
  "create index concurrently lp_idx_c on public.lock_probe (amount);" 'create index concurrently%' "drop index lp_idx_c"
blocked "ADD CHECK（NOT VALID 無し）" \
  "alter table public.lock_probe add constraint lp_chk check (amount >= 0);" \
  'alter table public.lock_probe add constraint lp_chk %' \
  "alter table public.lock_probe drop constraint lp_chk"

echo
echo "後片付け: 複製表を消します"
