#!/usr/bin/env bash
# WHY: issue #825（2026-09-30）。1 件の発注・返却の明細の件数の上限は 3 か所に現れる。
#        (1) 人が決めた値      aidd.config.json の limits.orderItemsMax
#        (2) RPC 側の防波堤    supabase/migrations の共有関数 assert_items_within_limit の v_max
#        (3) 入口での早い拒否  src/lib/validation/text-limits.ts の ORDER_ITEMS_MAX（設定から読む）
#      DB の関数は設定ファイルを読めないので、数字を migration に 1 つ書くしかない。
#      同じ数字が 2 か所に散ると必ずずれる（文字数の上限で 2026-09-07 に実際にずれていた）。
#      scripts/check-text-length-consistency.test.sh と同じ型で、機械で突き合わせる。
#
#   (a) 共有関数に書いた上限が、設定の値と一致する
#   (b) 上限を書いているのが 1 か所だけ（migration の中に v_max が 2 つ以上無い）
#   (c) 入口（text-limits.ts）が設定から読んでいる（数字を直接書いていない）
#   (d) fixture で (a) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-order-items-limit-consistency.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIG="$REPO_ROOT/aidd.config.json"
MIGRATION="$REPO_ROOT/supabase/migrations/20260930000000_limit_order_items_count_in_rpc.sql"
LIMITS_TS="$REPO_ROOT/src/lib/validation/text-limits.ts"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 設定の値
config_value() {
  node -e '
const fs = require("fs")
const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const v = cfg.limits?.orderItemsMax
console.log(Number.isInteger(v) ? v : "")
' "$1"
}

# migration の共有関数に書いた上限（v_max CONSTANT INTEGER := N の N。複数あれば全部出す）
migration_values() {
  grep -oE 'v_max CONSTANT INTEGER := [0-9]+' "$1" 2>/dev/null | grep -oE '[0-9]+$'
}

echo "=== scenario 1: 3 つのファイルが揃っている（fail-open 防止） ==="
missing=""
for f in "$CONFIG" "$MIGRATION" "$LIMITS_TS"; do
  [ -f "$f" ] || missing="$missing $f"
done
if [ -z "$missing" ]; then
  assert_ok "設定・migration・入口がすべてある"
else
  assert_fail "突合に必要なファイルが無い" "$missing"
fi

echo "=== scenario 2: 共有関数の上限が、人の決めた値と一致する ==="
CONFIG_VALUE="$(config_value "$CONFIG")"
DB_VALUES="$(migration_values "$MIGRATION")"
DB_COUNT="$(printf '%s\n' "$DB_VALUES" | grep -c .)"
if [ -z "$CONFIG_VALUE" ]; then
  assert_fail "設定に limits.orderItemsMax が無い（整数でない）"
elif [ "$DB_COUNT" -eq 0 ]; then
  assert_fail "migration から上限値を 1 つも読めない（走査が壊れている疑い）"
elif [ "$DB_COUNT" -ne 1 ]; then
  assert_fail "migration に上限が ${DB_COUNT} か所ある（1 か所だけにする）" "$(printf '%s ' $DB_VALUES)"
elif [ "$DB_VALUES" = "$CONFIG_VALUE" ]; then
  assert_ok "共有関数の上限（${DB_VALUES}）は設定（${CONFIG_VALUE}）と一致する"
else
  assert_fail "共有関数の上限が設定とずれている" "migration=${DB_VALUES} / aidd.config.json=${CONFIG_VALUE}
      値を変えるときは両方を同時に変える（設定が正本。migration は新しい 1 本で CREATE OR REPLACE する）"
fi

echo "=== scenario 3: 入口が設定から読んでいる（数字を直接書いていない） ==="
if grep -q 'limitsConfig.limits.orderItemsMax' "$LIMITS_TS" 2>/dev/null; then
  assert_ok "ORDER_ITEMS_MAX は設定から読んでいる"
else
  assert_fail "ORDER_ITEMS_MAX が設定から読まれていない" "$LIMITS_TS"
fi

echo "=== scenario 4: fixture で検知できる（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/config.json" <<'EOF'
{ "limits": { "orderItemsMax": 100 } }
EOF
cat > "$WORK/mig-bad.sql" <<'EOF'
DECLARE
  v_max CONSTANT INTEGER := 250;
EOF
cat > "$WORK/mig-ok.sql" <<'EOF'
DECLARE
  v_max CONSTANT INTEGER := 100;
EOF
cat > "$WORK/mig-twice.sql" <<'EOF'
  v_max CONSTANT INTEGER := 100;
  v_max CONSTANT INTEGER := 100;
EOF
CV="$(config_value "$WORK/config.json")"
if [ "$(migration_values "$WORK/mig-bad.sql")" != "$CV" ]; then assert_ok "ずれた上限を検知"; else assert_fail "ずれを検知できない"; fi
if [ "$(migration_values "$WORK/mig-ok.sql")" = "$CV" ]; then assert_ok "一致する値は誤検知しない"; else assert_fail "一致する値を違反にした"; fi
if [ "$(migration_values "$WORK/mig-twice.sql" | grep -c .)" -eq 2 ]; then assert_ok "2 か所に書いたことを数えられる"; else assert_fail "2 か所を数えられない"; fi
if [ -z "$(migration_values "$WORK/config.json")" ]; then assert_ok "上限の無いファイルでは空（走査の空振りを見分けられる）"; else assert_fail "無いのに読めた"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
