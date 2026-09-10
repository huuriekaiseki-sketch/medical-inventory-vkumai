#!/usr/bin/env bash
# WHY(2026-09-10): `SECURITY DEFINER` は RLS を通らない。client から呼べるのに
#      呼び出し元を確かめていない関数は、その時点で施設の境界が無い。
#      既存の `scan-guard-regressions.mjs` は「前の版にあった判定が消えた」しか見ないので、
#      **最初から判定の無い新しい関数は素通り**していた。
#
#      この穴は実測で見つけた: 仕込んだ「認可チェックの無い SECURITY DEFINER 関数」を
#      Sweep（LLM・haiku）は 5 回とも見逃した（sonnet は見つけたが 1 回 $2.50）。
#      **「必ず全件見る」を守らせるより、機械で数えるほうが確実で安い。**
#
#      固定するのは 4 つ:
#        (a) 実リポジトリに違反が無い（ratchet を 0 で張る）
#        (b) **仕込んだ欠陥で本当に落ちる**（eval の fixture をそのまま入力に使う）
#        (c) 正しく書かれたものは落とさない（対照）
#        (d) 走査が空振りしたら合格にしない（fail-open 防止）
#
# 実行: bash scripts/check-definer-authz-gaps.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-definer-authz-gaps.mjs"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

run_scan() { # $1 = migrations ディレクトリ
  SCAN_OUT="$(DEFINER_AUTHZ_DIR="$1" node "$SCAN" 2>&1)"
  SCAN_CODE=$?
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 実リポジトリに違反が無い（ratchet 0） ==="
run_scan "$REPO_ROOT/supabase/migrations"
if [ "$SCAN_CODE" -eq 0 ]; then ok "違反 0 件"; else ng "実リポジトリで違反が出た" "$SCAN_OUT"; fi
if printf '%s' "$SCAN_OUT" | grep -q "client-reachable-definer=[1-9]"; then
  ok "client から呼べる SECURITY DEFINER を実際に数えている（空振りでない）"
else
  ng "対象を 1 件も数えていない（走査が壊れている疑い）" "$SCAN_OUT"
fi

echo "=== scenario 2: eval の fixture（仕込んだ欠陥）で本当に落ちる ==="
# WHY(fixture をそのまま入力に使う): 検査と eval が**同じ欠陥**を見ていることを固定する。
#      別々の例を持つと、片方だけ直したときに気づけない。
for fx in \
  "scripts/eval-fixtures/sweep-db/case-1-security-definer-bypass" \
  "scripts/eval-fixtures/sweep-db-holdout/case-1-membership-check-on-wrong-subject"
do
  dir="$REPO_ROOT/$fx/files/supabase/migrations"
  if [ ! -d "$dir" ]; then ng "fixture が無い: $fx"; continue; fi
  run_scan "$dir"
  if [ "$SCAN_CODE" -ne 0 ] && printf '%s' "$SCAN_OUT" | grep -q "definer-authz-gap"; then
    ok "$(basename "$fx") を検知"
  else
    ng "$(basename "$fx") を検知できない（rc=${SCAN_CODE}）" "$SCAN_OUT"
  fi
done

echo "=== scenario 3: 正しく書かれたものは落とさない（対照） ==="
dir="$REPO_ROOT/scripts/eval-fixtures/sweep-db/case-2-negative-control/files/supabase/migrations"
run_scan "$dir"
if [ "$SCAN_CODE" -eq 0 ]; then ok "陰性対照は違反にしない"; else ng "正しいものを落とした" "$SCAN_OUT"; fi

echo "=== scenario 4: client へ GRANT していない DEFINER は対象外 ==="
mkdir -p "$WORK/nogrant"
cat > "$WORK/nogrant/20260101000000_x.sql" <<'SQL'
CREATE OR REPLACE FUNCTION internal_only_fn(p UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true;
$$;
SQL
run_scan "$WORK/nogrant"
if [ "$SCAN_CODE" -eq 0 ]; then ok "client から呼べないものは違反にしない"; else ng "到達できない関数を落とした" "$SCAN_OUT"; fi

echo "=== scenario 5: GRANT のあとに REVOKE すれば対象外に戻る ==="
mkdir -p "$WORK/revoked"
cat > "$WORK/revoked/20260101000000_a.sql" <<'SQL'
CREATE OR REPLACE FUNCTION revoked_fn(p UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true;
$$;
GRANT EXECUTE ON FUNCTION revoked_fn TO anon, authenticated;
SQL
run_scan "$WORK/revoked"
if [ "$SCAN_CODE" -ne 0 ]; then ok "GRANT だけなら違反（前提の確認）"; else ng "GRANT した無防備な関数を見逃した" "$SCAN_OUT"; fi
cat > "$WORK/revoked/20260102000000_b.sql" <<'SQL'
REVOKE EXECUTE ON FUNCTION revoked_fn FROM anon, authenticated;
SQL
run_scan "$WORK/revoked"
if [ "$SCAN_CODE" -eq 0 ]; then ok "REVOKE すれば対象外（順番を畳んでいる）"; else ng "REVOKE を見ていない" "$SCAN_OUT"; fi

echo "=== scenario 6: 逃がす印は理由が要る ==="
mkdir -p "$WORK/open"
cat > "$WORK/open/20260101000000_x.sql" <<'SQL'
-- definer-open:
CREATE OR REPLACE FUNCTION open_fn(p UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true;
$$;
GRANT EXECUTE ON FUNCTION open_fn TO authenticated;
SQL
run_scan "$WORK/open"
if [ "$SCAN_CODE" -ne 0 ]; then ok "理由の無い印では逃がさない"; else ng "空の理由で通した" "$SCAN_OUT"; fi
cat > "$WORK/open/20260101000000_x.sql" <<'SQL'
-- definer-open: 認証の有無だけを返す公開エンドポイントで、施設のデータを返さないため
CREATE OR REPLACE FUNCTION open_fn(p UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT true;
$$;
GRANT EXECUTE ON FUNCTION open_fn TO authenticated;
SQL
run_scan "$WORK/open"
if [ "$SCAN_CODE" -eq 0 ]; then ok "理由を書けば逃がす（対照）"; else ng "理由付きでも通らない" "$SCAN_OUT"; fi

echo "=== scenario 7: 「誰かが所属しているか」は認可チェックに数えない ==="
# WHY: held-out fixture と同じ形。`user_facilities` を引いていても、
#      `auth.uid()` と突き合わせていなければ呼び出し元は誰でもよい
mkdir -p "$WORK/wrongsubject"
cat > "$WORK/wrongsubject/20260101000000_x.sql" <<'SQL'
CREATE OR REPLACE FUNCTION wrong_subject_fn(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_facilities uf WHERE uf.facility_id = p_facility_id);
$$;
GRANT EXECUTE ON FUNCTION wrong_subject_fn TO authenticated;
SQL
run_scan "$WORK/wrongsubject"
if [ "$SCAN_CODE" -ne 0 ]; then ok "利用者と突き合わせていない条件は認可チェックにしない"; else ng "「誰かが所属」を認可と読んだ" "$SCAN_OUT"; fi

# 対照: auth.uid() と突き合わせれば通る
cat > "$WORK/wrongsubject/20260101000000_x.sql" <<'SQL'
CREATE OR REPLACE FUNCTION wrong_subject_fn(p_facility_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_facilities uf
    WHERE uf.facility_id = p_facility_id AND uf.user_id = auth.uid()
  );
$$;
GRANT EXECUTE ON FUNCTION wrong_subject_fn TO authenticated;
SQL
run_scan "$WORK/wrongsubject"
if [ "$SCAN_CODE" -eq 0 ]; then ok "呼び出し元と突き合わせれば通る（対照）"; else ng "正しい形を落とした" "$SCAN_OUT"; fi

echo "=== scenario 8: 走査が空振りしたら合格にしない（fail-open 防止） ==="
mkdir -p "$WORK/empty"
run_scan "$WORK/empty"
if [ "$SCAN_CODE" -ne 0 ]; then ok "関数 0 件なら落とす"; else ng "空でも合格にした" "$SCAN_OUT"; fi

echo "=== scenario 9: 読み飛ばしを検知する（宣言の数と解析できた数） ==="
mkdir -p "$WORK/unparsable"
cat > "$WORK/unparsable/20260101000000_x.sql" <<'SQL'
CREATE OR REPLACE FUNCTION good_fn()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL;
$$;
CREATE OR REPLACE FUNCTION weird_fn() RETURNS BOOLEAN LANGUAGE sql AS 'SELECT true';
SQL
run_scan "$WORK/unparsable"
if [ "$SCAN_CODE" -ne 0 ] && printf '%s' "$SCAN_OUT" | grep -q "しか解析できていない"; then
  ok "解析できなかった定義があれば落とす"
else
  ng "黙って読み飛ばした（rc=${SCAN_CODE}）" "$SCAN_OUT"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
