#!/usr/bin/env bash
# WHY(2026-09-13): docs/agents/security-test-catalog.md の引き金「RLS ポリシーが 30 本を超えたら」は、
#      「**数える口が無い**（静的には判定不能。現存数は実 DB の pg_policies が要る）」として
#      「引き金が引けない行」に載せてあった。**その断定が誤りだった。**
#      当時は CREATE の出現回数（115）と DROP（95）を数えただけで、**順に再生していなかった**。
#      再生したら 35 本で、**閾値 30 はとっくに超えていた**。
#      （C-010: 印だけがある状態を、よりによって「引けない」と宣言する形で作っていた）
#
#      上限は**実測した現在値 35 で張る**。30 で張ると初日から赤くなり、
#      **初日から赤い検査は真っ先に無効化される**。守るのは「これ以上増やさない」だけ
#      （splittableMax / unclassifiedMax と同じ帯）。30 超という事実は台帳の
#      `_reviewTrigger` に記録し、**この検査の合否には使わない**——着手するかは人が決める。
#
#   (a) 実態の migration を再生して、本数が上限（rls-policy-budget.json の max）以内
#   (b) 解釈できなかった POLICY 行が 0 件（読めない行を黙って飛ばさない。C-044）
#   (c) 危険な名前（auth_only = USING (true)）が 1 つも残っていない
#   (d) 台帳の衛生（max が整数・実測の記録と限界が空でない。C-049）
#   (e) fixture で検知できる（RED 方向）: 上限超過 / 動的ループの展開 / 読めない行の名指し
#   (f) 走査が空振りしていない（migration が 1 本も無ければ落ちる。fail-open 防止）
#
# 限界: 数えるのは**本数**であって中身の正しさは見ない（RLS 変異計測 H-06 と
#      scripts/check-rls-grant-gaps.test.sh の担当）。再生器自身の限界は
#      scripts/lib/replay-rls-policies.mjs の先頭に書いてある。
#
# 実行: bash scripts/check-rls-policy-count.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12・E-086): 配られると自分は配布物の中にある。$SCRIPT_DIR/.. を導入先だと
#      思い込むと、導入先の木を一度も見ないまま落ちる。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
fi

REPLAY="$SCRIPT_DIR/lib/replay-rls-policies.mjs"
BUDGET="$SCRIPT_DIR/lib/rls-policy-budget.json"
MIGRATIONS="${RLS_COUNT_MIGRATIONS:-$REPO_ROOT/supabase/migrations}"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 確認不能を合格にも違反にもしない（C-025）
command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので migration を再生できません。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}
[ -f "$REPLAY" ] || {
  echo "  NG: 再生器が実在しません: $REPLAY"
  echo "FAILED"
  exit 1
}
if [ ! -d "$MIGRATIONS" ]; then
  echo "  SKIP: 対象なし（supabase/migrations がありません）"
  echo "ALL PASSED"
  exit 0
fi

run_replay() { node "$REPLAY" --migrations "$1" 2>&1; }
val() { grep -m1 "^$2=" <<<"$1" | cut -d= -f2; }
# 判定はこのスクリプトにある。境界を fixture で確かめられるよう関数に出す
over_budget() { [ "$1" -gt "$2" ]; }

echo "=== scenario 1: 台帳の衛生（上限・実測の記録・限界が埋まっている） ==="
if [ ! -f "$BUDGET" ]; then
  assert_fail "上限の台帳が実在しません: $BUDGET"
  MAX=""
else
  MAX="$(node -e "const b=require('$BUDGET');process.stdout.write(String(b.max))" 2>/dev/null || echo "")"
  if [[ "$MAX" =~ ^[0-9]+$ ]]; then
    assert_ok "上限は整数（max=${MAX}）"
  else
    assert_fail "上限 max が整数ではありません" "max=${MAX}"
  fi
  for key in _measured _limits _comment; do
    v="$(node -e "const b=require('$BUDGET');process.stdout.write(String(b['$key']||''))" 2>/dev/null || echo "")"
    if [ ${#v} -ge 20 ]; then
      assert_ok "${key} が書いてある"
    else
      assert_fail "${key} が空か短すぎます（なぜその上限かが残らない）" "${key}=${v}"
    fi
  done
fi

echo "=== scenario 2: 実態を再生して、本数が上限以内 ==="
OUT="$(run_replay "$MIGRATIONS")"
RC=$?
if [ "$RC" -ne 0 ]; then
  assert_fail "再生できませんでした（確認不能を緑にしない）" "$OUT"
else
  FILES="$(val "$OUT" files)"
  LIVE="$(val "$OUT" live)"
  if [ "${FILES:-0}" -ge 1 ]; then
    assert_ok "migration ${FILES} 本を再生した"
  else
    assert_fail "migration を 1 本も見つけられません（走査が空振りしている）"
  fi
  if [ -n "$MAX" ] && [[ "$MAX" =~ ^[0-9]+$ ]]; then
    if over_budget "${LIVE:-0}" "$MAX"; then
      assert_fail "ポリシーが上限を超えました（${LIVE} 本 > 上限 ${MAX}）" \
        "増やすなら scripts/lib/rls-policy-budget.json の max を 1 件ずつ上げ、なぜ増やすのかを PR に書く"
    else
      assert_ok "現存 ${LIVE} 本（上限 ${MAX} 以内）"
    fi
  fi
fi

echo "=== scenario 3: 解釈できなかった POLICY 行が無い（読めない行を飛ばさない） ==="
UNPARSED="$(val "$OUT" unparsed)"
if [ "${UNPARSED:-1}" -eq 0 ]; then
  assert_ok "解釈できなかった POLICY 行なし"
else
  assert_fail "解釈できない POLICY 行があります（本数が実態より少なく出ます）" \
    "$(grep '^UNPARSED ' <<<"$OUT")"
fi

echo "=== scenario 4: 危険な名前のポリシーが残っていない ==="
DANGER="$(val "$OUT" dangerous)"
if [ "${DANGER:-1}" -eq 0 ]; then
  assert_ok "auth_only（USING (true)）の残存なし"
else
  assert_fail "認証さえ通れば全施設が読めるポリシーが残っています" \
    "$(grep '^DANGEROUS ' <<<"$OUT")"
fi

echo "=== scenario 5: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# (5a) 動的ループを展開できる。展開しないと 0 本と数えて「上限内」と嘘をつく
mkdir -p "$WORK/dyn"
cat > "$WORK/dyn/20260101000000_loop.sql" <<'EOF'
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['a_table', 'b_table', 'c_table'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS "auth_only" ON %I', t);
    EXECUTE format(
      'CREATE POLICY "member_only" ON %I FOR ALL TO authenticated USING (true)', t
    );
  END LOOP;
END
$$;
EOF
DYN="$(run_replay "$WORK/dyn")"
if [ "$(val "$DYN" live)" -eq 3 ]; then
  assert_ok "動的ループを 3 表へ展開できる"
else
  assert_fail "動的ループを展開できない（本数が実態より少なく出る）" "$DYN"
fi

# (5b) 危険な名前を検知する
mkdir -p "$WORK/danger"
cat > "$WORK/danger/20260101000000_open.sql" <<'EOF'
CREATE POLICY "auth_only" ON some_table FOR ALL TO authenticated USING (true);
EOF
DNG="$(run_replay "$WORK/danger")"
if [ "$(val "$DNG" dangerous)" -eq 1 ]; then
  assert_ok "auth_only の残存を検知"
else
  assert_fail "auth_only を検知できない" "$DNG"
fi

# (5c) 読めない POLICY 行を名指しする
mkdir -p "$WORK/unparsed"
cat > "$WORK/unparsed/20260101000000_weird.sql" <<'EOF'
EXECUTE some_helper('CREATE POLICY dynamic_thing ON ' || quote_ident(v_name));
EOF
UNP="$(run_replay "$WORK/unparsed")"
if [ "$(val "$UNP" unparsed)" -ge 1 ]; then
  assert_ok "読めない POLICY 行を名指しする"
else
  assert_fail "読めない POLICY 行を黙って飛ばしている" "$UNP"
fi

# (5d) 作って消せば残らない（対照。いつも数えているだけではないこと）
mkdir -p "$WORK/pair"
cat > "$WORK/pair/20260101000000_a.sql" <<'EOF'
CREATE POLICY "p1" ON t1 FOR ALL TO authenticated USING (true);
EOF
cat > "$WORK/pair/20260102000000_b.sql" <<'EOF'
DROP POLICY IF EXISTS "p1" ON t1;
EOF
PAIR="$(run_replay "$WORK/pair")"
if [ "$(val "$PAIR" live)" -eq 0 ]; then
  assert_ok "作って消したポリシーは残らない（順に再生できている）"
else
  assert_fail "DROP が効いていない（出現回数を数えているだけ）" "$PAIR"
fi

# (5e) 上限の判定そのもの（境界）
if over_budget 36 35; then assert_ok "36 > 35 を超過と判定"; else assert_fail "超過を検知しない"; fi
if over_budget 35 35; then assert_fail "35 を超過と誤判定（境界が 1 ずれている）"; else assert_ok "35 は上限内（境界）"; fi

echo "=== scenario 6: migration が 1 本も無ければ落ちる（fail-open 防止） ==="
mkdir -p "$WORK/empty"
EMP="$(run_replay "$WORK/empty")"
if [ "$(val "$EMP" files)" -eq 0 ]; then
  assert_ok "0 本を 0 本と報告する（入口が違反として扱う）"
else
  assert_fail "空のディレクトリで 0 本と言わない" "$EMP"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
