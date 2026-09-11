#!/usr/bin/env bash
# WHY(2026-09-08 に自分でやった): `CREATE OR REPLACE FUNCTION` は本文をまるごと差し替える。
#      **古い版を元に書き直すと、後から入った強化が黙って消える。**
#      その日 `20260908070000` が `get_order_amount_report` を書き直したとき、元にしたのが
#      最初の版だったため、20260907000001 で足してあった `has_aal2()` の判定が消え、
#      **パスワードだけを奪われた admin（aal1）が全施設の金額を読める状態**に戻っていた。
#      気づけたのは統合テストが落ちたからで、書いた本人は気づいていない。
#
#      この検査は「落ちるテストがある強化」だけでなく、**無いものも**拾うためのもの。
#      検査そのものが空振りすると意味が無いので、次の 7 つを固定する:
#
#   1. 実態の migration に違反が無い
#   2. **今日の実物**（has_aal2 を落とす再定義）をちょうど検知する（RED 方向）
#   3. 強化（is_facility_member → is_facility_writer）は違反にしない
#   4. `-- drops-guard: 理由` を書けば通す（意図的に外す道を残す）
#   5. `SET search_path` を落とす再定義も検知する
#   6. 関数を 1 つも見つけられなければ落ちる（fail-open 防止）
#   7. **宣言の数と解析できた数が食い違えば落ちる**（黙って読み飛ばさない）
#      → 7 が実際に効いた。`$function$` のタグ付きドル引用符を 1 件読み飛ばしていたのを、
#        「タグ付きは無い」と確かめたつもりの grep ではなく**この突合**が捕まえた
#
# 実行: bash scripts/check-guard-regressions.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/..` を使うと
#      **プラグイン自身**を導入先だと思い込み、導入先の木を一度も見ないまま落ちる（E-086）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi
SCANNER="$SCRIPT_DIR/lib/scan-guard-regressions.mjs"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected to find: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  NG: $label"; echo "      unexpected: $needle"; echo "      actual: $haystack"; fail=1
  else echo "  OK: $label"; fi
}

WORK_DIR="$(mktemp -d)"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

run_on() { GUARD_REGRESSION_DIR="$1" node "$SCANNER" 2>&1; }

echo "=== scenario 1: 実態の migration に違反が無い ==="
# WHY(2026-09-12): 配った先の migration に関数定義が 1 つも無いことはふつうにある。
#      そこで「走査が壊れている」と赤くするのは**持っていないだけで赤くなる**形（E-086）。
#      対象が無ければ対象なしとして黙る（走査の故障は、対象がある導入先でだけ意味を持つ）。
OUT="$(cd "$REPO_ROOT" && node "$SCANNER" 2>&1)"
CODE=$?
if grep -qF -- "関数を 1 つも見つけられなかった" <<<"$OUT"; then
  echo "  OK: この導入先の migration に関数定義が無いので対象なし"
else
  assert_contains "$OUT" "violations=0" "違反なし"
  if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi
fi

echo "=== scenario 2: 今日の実物（has_aal2 を落とす再定義）を検知する ==="
BAD="$WORK_DIR/aal2"
mkdir -p "$BAD"
cat > "$BAD/20260101000000_create.sql" <<'SQL'
CREATE OR REPLACE FUNCTION get_report(p_from TIMESTAMPTZ)
RETURNS TABLE(x INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'permission denied'; END IF;
  RETURN QUERY SELECT 1;
END;
$$;
SQL
cat > "$BAD/20260102000000_harden.sql" <<'SQL'
CREATE OR REPLACE FUNCTION get_report(p_from TIMESTAMPTZ)
RETURNS TABLE(x INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'permission denied'; END IF;
  IF NOT has_aal2() THEN RAISE EXCEPTION 'forbidden: aal2 required'; END IF;
  RETURN QUERY SELECT 1;
END;
$$;
SQL
cat > "$BAD/20260103000000_rewrite_from_old.sql" <<'SQL'
CREATE OR REPLACE FUNCTION get_report(p_from TIMESTAMPTZ)
RETURNS TABLE(x INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'permission denied'; END IF;
  RETURN QUERY SELECT 2;
END;
$$;
SQL
OUT="$(run_on "$BAD")"
assert_contains "$OUT" "guard-lost: get_report" "落ちた守りを名指しする"
assert_contains "$OUT" "has_aal2()" "何が消えたかを出す"
assert_contains "$OUT" "20260102000000_harden.sql" "どの版から消えたかを出す"
assert_contains "$OUT" "20260103000000_rewrite_from_old.sql" "どこで消えたかを出す"

echo "=== scenario 3: 強化（member → writer）は違反にしない ==="
STRONGER="$WORK_DIR/stronger"
mkdir -p "$STRONGER"
cat > "$STRONGER/20260101000000_create.sql" <<'SQL'
CREATE OR REPLACE FUNCTION create_order(p_facility_id UUID)
RETURNS UUID LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT public.is_facility_member(p_facility_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN gen_random_uuid();
END;
$$;
SQL
cat > "$STRONGER/20260102000000_tighten.sql" <<'SQL'
CREATE OR REPLACE FUNCTION create_order(p_facility_id UUID)
RETURNS UUID LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NOT public.is_facility_writer(p_facility_id) THEN RAISE EXCEPTION 'forbidden'; END IF;
  RETURN gen_random_uuid();
END;
$$;
SQL
OUT="$(run_on "$STRONGER")"
assert_contains "$OUT" "violations=0" "狭める変更は違反にしない"

echo "=== scenario 4: -- drops-guard: 理由 があれば通す ==="
ALLOWED="$WORK_DIR/allowed"
mkdir -p "$ALLOWED"
cp "$BAD/20260101000000_create.sql" "$ALLOWED/"
cp "$BAD/20260102000000_harden.sql" "$ALLOWED/"
{
  echo "-- drops-guard: この集計は公開ダッシュボード用に変わったので aal2 を要求しない（人が決定）"
  cat "$BAD/20260103000000_rewrite_from_old.sql"
} > "$ALLOWED/20260103000000_rewrite_from_old.sql"
OUT="$(run_on "$ALLOWED")"
assert_contains "$OUT" "violations=0" "理由付きで外せば通す"

echo "=== scenario 4b: 理由の無い drops-guard は通さない ==="
NOREASON="$WORK_DIR/noreason"
mkdir -p "$NOREASON"
cp "$BAD/20260101000000_create.sql" "$NOREASON/"
cp "$BAD/20260102000000_harden.sql" "$NOREASON/"
{
  echo "-- drops-guard:"
  cat "$BAD/20260103000000_rewrite_from_old.sql"
} > "$NOREASON/20260103000000_rewrite_from_old.sql"
OUT="$(run_on "$NOREASON")"
assert_contains "$OUT" "guard-lost: get_report" "理由が空なら逃がさない"

echo "=== scenario 5: SET search_path を落とす再定義も検知する ==="
SP="$WORK_DIR/searchpath"
mkdir -p "$SP"
cat > "$SP/20260101000000_create.sql" <<'SQL'
CREATE OR REPLACE FUNCTION helper()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true
$$;
SQL
cat > "$SP/20260102000000_rewrite.sql" <<'SQL'
CREATE OR REPLACE FUNCTION helper()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT true
$$;
SQL
OUT="$(run_on "$SP")"
assert_contains "$OUT" "SET search_path" "search_path の固定が消えたのを検知"

echo "=== scenario 6: 関数が 1 つも無ければ落ちる（fail-open 防止）==="
EMPTY="$WORK_DIR/empty"
mkdir -p "$EMPTY"
OUT="$(run_on "$EMPTY")"
CODE=$?
assert_contains "$OUT" "走査が壊れている" "空振りを違反として報告する"
if [ "$CODE" -ne 0 ]; then echo "  OK: exit ${CODE}（0 でない）"; else echo "  NG: 空振りなのに exit 0"; fail=1; fi

echo "=== scenario 7: 解析できない書き方があれば落ちる（黙って読み飛ばさない）==="
# WHY: これが実際に効いた。`$function$` のタグ付きを 1 件読み飛ばしていたのを、
#      「タグ付きは無い」と確かめたつもりの grep ではなくこの突合が捕まえた。
WEIRD="$WORK_DIR/weird"
mkdir -p "$WEIRD"
cat > "$WEIRD/20260101000000_odd.sql" <<'SQL'
CREATE OR REPLACE FUNCTION odd_one()
RETURNS TRIGGER LANGUAGE plpgsql AS '
BEGIN
  RETURN NEW;
END;
';
SQL
OUT="$(run_on "$WEIRD")"
CODE=$?
if [ "$CODE" -ne 0 ]; then echo "  OK: 解析できない定義で exit $CODE"; else echo "  NG: 読み飛ばしたのに exit 0"; fail=1; fi

echo "=== scenario 8: タグ付きのドル引用符も解析できる ==="
TAGGED="$WORK_DIR/tagged"
mkdir -p "$TAGGED"
cat > "$TAGGED/20260101000000_create.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.tagged_fn()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  RAISE LOG 'x';
END;
$function$;
SQL
cat > "$TAGGED/20260102000000_rewrite.sql" <<'SQL'
CREATE OR REPLACE FUNCTION public.tagged_fn()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
  RAISE LOG 'y';
END;
$function$;
SQL
OUT="$(run_on "$TAGGED")"
assert_contains "$OUT" "definitions=2" "タグ付きを 2 件とも解析できる"
assert_contains "$OUT" "SET search_path" "タグ付きでも守りの欠落を検知する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
