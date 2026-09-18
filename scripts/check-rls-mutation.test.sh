#!/usr/bin/env bash
# WHY: check-rls-mutation.sh の**数え方**を実 DB 無しで確かめる（2026-09-10）。
#      直前まで、この計測には未変異の正常系（対照）が無く、
#      「壊す前から赤いテスト」も「倒した」に数えていた。さらに実行エラーの件数 errors は
#      どこにも効いておらず、全件が実行エラーでも ALL KILLED で終わった。
#      本体は実 DB と実テストが要るので、supabase / vitest を差し替え口
#      （RLS_MUTATION_SUPABASE_CMD / RLS_MUTATION_VITEST_CMD）から偽物に替え、
#      「何をどう数え、どこで赤にするか」だけを機械で回す。
#
#      scenario 2 が RED 対照になっている（対照が赤いときに ALL KILLED を出さないこと）。
#      修正前のスクリプトなら scenario 2 は緑で通ってしまう。
#
# 実行: bash scripts/check-rls-mutation.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET="$SCRIPT_DIR/check-rls-mutation.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MIGDIR="$WORK/migrations"
mkdir -p "$MIGDIR"
cat > "$MIGDIR/00000000000001_policies.sql" <<'SQL'
CREATE POLICY "facility_members_select" ON facilities FOR SELECT USING (true);
CREATE POLICY "orders_insert_writer" ON orders FOR INSERT WITH CHECK (true);
SQL

# expect は REPO_ROOT からの相対パスで実在が確かめられる（偽 vitest は実際には走らせない）
EXPECT_A="scripts/check-rls-mutation.sh"
EXPECT_B="scripts/check-rls-mutation.test.sh"

cat > "$WORK/mutants.json" <<JSON
{
  "mutants": [
    {
      "id": "M-A",
      "breaks": "facilities の SELECT を誰でも通す",
      "sql": "DROP POLICY IF EXISTS \\"facility_members_select\\" ON facilities;",
      "expect": "$EXPECT_A"
    },
    {
      "id": "M-B",
      "breaks": "orders の INSERT を誰でも通す",
      "sql": "DROP POLICY IF EXISTS \\"orders_insert_writer\\" ON orders;",
      "expect": "$EXPECT_B"
    }
  ]
}
JSON

# --- 偽の supabase / vitest -------------------------------------------------
cat > "$WORK/fake-supabase" <<'SH'
#!/usr/bin/env bash
# db push だけ FAKE_PUSH_EXIT に従う。ほかは常に成功。
if [ "${1:-}" = "db" ] && [ "${2:-}" = "push" ]; then
  exit "${FAKE_PUSH_EXIT:-0}"
fi
exit 0
SH

cat > "$WORK/fake-vitest" <<'SH'
#!/usr/bin/env bash
# 壊す migration が置かれているかで「対照の実行」と「変異中の実行」を見分ける。
# exit 0 = テストが通った / exit 1 = テストが落ちた
if [ -f "$FAKE_MUTANT_FILE" ]; then
  exit "${FAKE_MUTATED_EXIT:-1}"
fi
for spec in ${FAKE_BASELINE_RED_TESTS:-}; do
  case "${*}" in
    *"$spec"*) exit 1 ;;
  esac
done
exit "${FAKE_BASELINE_EXIT:-0}"
SH
chmod +x "$WORK/fake-supabase" "$WORK/fake-vitest"

run_target() { # 残りの引数は変異 ID
  RUN_OUT="$(
    RLS_MUTATION_CATALOG="$WORK/mutants.json" \
    RLS_MUTATION_MIGRATIONS_DIR="$MIGDIR" \
    RLS_MUTATION_SUPABASE_CMD="$WORK/fake-supabase" \
    RLS_MUTATION_VITEST_CMD="$WORK/fake-vitest" \
    FAKE_MUTANT_FILE="$MIGDIR/99999999999999_rls_mutant.sql" \
    AIDD_LOG_DIR="$WORK/logs" \
    bash "$TARGET" "$@" 2>&1
  )"
  RUN_CODE=$?
}

echo "=== scenario 1: 対照が緑で、壊したらテストが落ちる（本来の緑） ==="
export FAKE_BASELINE_EXIT=0 FAKE_MUTATED_EXIT=1 FAKE_PUSH_EXIT=0
unset FAKE_BASELINE_RED_TESTS
run_target
if [ "$RUN_CODE" -eq 0 ]; then ok "exit 0"; else ng "exit ${RUN_CODE}" "$RUN_OUT"; fi
case "$RUN_OUT" in
  *"ALL KILLED"*) ok "ALL KILLED を出す" ;;
  *) ng "ALL KILLED が出ない" "$RUN_OUT" ;;
esac
case "$RUN_OUT" in
  *"倒した 2 / 生き残り 0 / 計測不能 0"*) ok "2 件とも倒したと数える" ;;
  *) ng "件数の内訳が出ない" "$RUN_OUT" ;;
esac

echo "=== scenario 2: 対照が赤（壊す前から落ちている）→ 撃破に数えない ==="
# ここが RED 対照。対照を取らない実装だと、この状況でも「倒した 2」で ALL KILLED になる。
export FAKE_BASELINE_EXIT=1 FAKE_MUTATED_EXIT=1 FAKE_PUSH_EXIT=0
run_target
if [ "$RUN_CODE" -ne 0 ]; then ok "exit 1（計測不能を緑にしない）"; else ng "対照が赤なのに exit 0" "$RUN_OUT"; fi
case "$RUN_OUT" in
  *"ALL KILLED"*) ng "対照が赤なのに ALL KILLED を出した" "$RUN_OUT" ;;
  *) ok "ALL KILLED を出さない" ;;
esac
case "$RUN_OUT" in
  *"倒した 0 / 生き残り 0 / 計測不能 2"*) ok "2 件とも計測不能と数える" ;;
  *) ng "計測不能として数えていない" "$RUN_OUT" ;;
esac
case "$RUN_OUT" in
  *"対照が赤 2"*) ok "計測不能の内訳に理由が出る" ;;
  *) ng "内訳に理由が出ない" "$RUN_OUT" ;;
esac

echo "=== scenario 3: 壊してもテストが通る（生き残り） ==="
export FAKE_BASELINE_EXIT=0 FAKE_MUTATED_EXIT=0 FAKE_PUSH_EXIT=0
run_target
if [ "$RUN_CODE" -ne 0 ]; then ok "exit 1"; else ng "生き残りがあるのに exit 0" "$RUN_OUT"; fi
case "$RUN_OUT" in
  *"倒した 0 / 生き残り 2 / 計測不能 0"*) ok "2 件とも生き残りと数える" ;;
  *) ng "生き残りとして数えていない" "$RUN_OUT" ;;
esac

echo "=== scenario 4: 壊す migration を適用できない → 計測不能で赤 ==="
export FAKE_BASELINE_EXIT=0 FAKE_MUTATED_EXIT=1 FAKE_PUSH_EXIT=1
run_target
if [ "$RUN_CODE" -ne 0 ]; then ok "exit 1（実行エラーを緑にしない）"; else ng "適用できないのに exit 0" "$RUN_OUT"; fi
case "$RUN_OUT" in
  *"倒した 0 / 生き残り 0 / 計測不能 2"*) ok "2 件とも計測不能と数える" ;;
  *) ng "計測不能として数えていない" "$RUN_OUT" ;;
esac
case "$RUN_OUT" in
  *"適用できない 2"*) ok "計測不能の内訳に理由が出る" ;;
  *) ng "内訳に理由が出ない" "$RUN_OUT" ;;
esac

echo "=== scenario 5: 混在しても母数は対象件数のまま（1/1 に見せない） ==="
export FAKE_BASELINE_EXIT=0 FAKE_MUTATED_EXIT=1 FAKE_PUSH_EXIT=0
export FAKE_BASELINE_RED_TESTS="$EXPECT_B"
run_target
unset FAKE_BASELINE_RED_TESTS
if [ "$RUN_CODE" -ne 0 ]; then ok "exit 1"; else ng "計測不能があるのに exit 0" "$RUN_OUT"; fi
case "$RUN_OUT" in
  *"対象 2 件: 倒した 1 / 生き残り 0 / 計測不能 1"*) ok "母数は 2 のまま（倒した 1 / 1 にしない）" ;;
  *) ng "母数が対象件数になっていない" "$RUN_OUT" ;;
esac
case "$RUN_OUT" in
  *"測れた 1 件のうち倒した 1 件"*) ok "測れた分の内訳も別に出る" ;;
  *) ng "測れた分の内訳が出ない" "$RUN_OUT" ;;
esac

echo "=== scenario 6: 記録に計測不能の内訳が残る ==="
if [ -f "$WORK/logs/rls-mutation-runs.jsonl" ]; then
  LAST="$(tail -n 1 "$WORK/logs/rls-mutation-runs.jsonl")"
  case "$LAST" in
    *'"baselineRed"'*) ok "baselineRed を記録している" ;;
    *) ng "baselineRed が記録に無い" "$LAST" ;;
  esac
  case "$LAST" in
    *'"applyErrors"'*) ok "applyErrors を記録している" ;;
    *) ng "applyErrors が記録に無い" "$LAST" ;;
  esac
  case "$LAST" in
    *'"targeted"'*) ok "targeted（対象件数）を記録している" ;;
    *) ng "targeted が記録に無い" "$LAST" ;;
  esac
else
  ng "記録ファイルが作られていない" "$WORK/logs"
fi

echo "=== scenario 7: 壊す migration が残らない ==="
if [ -f "$MIGDIR/99999999999999_rls_mutant.sql" ]; then
  ng "壊す migration が残っている"
else
  ok "壊す migration は片付いている"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
