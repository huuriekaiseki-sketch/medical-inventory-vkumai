#!/bin/bash
# WHY: scripts/derive-test-selection.sh（必須テストの機械導出）の回帰テスト。
# 変更パスの組み合わせごとに「今回必須 / 今回不要（理由付き）/ 節目」がどう出るかを固定し、
# ルール表（scripts/lib/derive-test-selection.rules.mjs）や高リスク判定の正本
# （.claude/workflows/lib/router-risk.js）を変えたときに導出結果が黙って変わらないようにする。
# git には触れず --files で入力を注入するため決定的。
#
# 実行: bash scripts/derive-test-selection.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/derive-test-selection.sh"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then echo "  OK: $label"; else echo "  NG: $label (expected=$expected actual=$actual)"; fail=1; fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected to find: $needle"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  NG: $label"; echo "      unexpected: $needle"; fail=1; else echo "  OK: $label"; fi
}

# required / not_required / milestone の key を改行区切りで取り出す
keys_of() { # $1=json $2=section
  printf '%s' "$1" | jq -r --arg s "$2" '.[$s][].key'
}

run() { # 引数をそのまま渡し、stdout と exit code を OUT / EXIT_CODE に入れる
  set +e
  OUT="$(bash "$SCRIPT" "$@" 2>/dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: 文書のみの変更 → 毎回の種別だけ required、変更時は全て理由付き not_required ==="
run --files docs/agents/decisions.md
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$(printf '%s' "$OUT" | jq -r '.route')" "meta" "route は meta（docs/agents のみ）"
assert_eq "$(keys_of "$OUT" required | grep -c -e '^typecheck$' -e '^lint$' -e '^unit$' -e '^build$')" "4" "毎回の4種別が required"
assert_contains "$(keys_of "$OUT" not_required)" "rls-idor-integration" "RLS/IDOR 統合は not_required"
assert_eq "$(printf '%s' "$OUT" | jq -r '.not_required[] | select(.reason == "" or .reason == null) | .key' | wc -l | tr -d ' ')" "0" "not_required に理由の無い行が無い"
assert_eq "$(printf '%s' "$OUT" | jq -r '.unclassified | length')" "0" "未分類なし"

echo "=== scenario 2: src/lib/supabase → RLS/IDOR 統合・生成型・直接攻撃が required、route は deep ==="
run --files src/lib/supabase/orders.ts
assert_eq "$(printf '%s' "$OUT" | jq -r '.route')" "deep" "route は deep"
assert_contains "$(keys_of "$OUT" required)" "rls-idor-integration" "RLS/IDOR 統合が required"
assert_contains "$(keys_of "$OUT" required)" "generated-types" "生成型の鮮度が required"
assert_contains "$(keys_of "$OUT" required)" "direct-attack" "直接攻撃の実測が required"
assert_contains "$(printf '%s' "$OUT" | jq -r '.required[] | select(.key=="rls-idor-integration") | .why')" "src/lib/supabase/orders.ts" "理由に触れたパスが入る"
assert_not_contains "$(keys_of "$OUT" not_required)" "rls-idor-integration" "not_required 側には出ない"

echo "=== scenario 3: proxy.ts（ファイル名一致の高リスク）も同じ扱い ==="
run --files src/proxy.ts
assert_contains "$(keys_of "$OUT" required)" "rls-idor-integration" "proxy.ts で RLS/IDOR 統合が required"

echo "=== scenario 4: 高リスクでない製品コード + 高リスク判定に無い supabase/__tests__ → integration-gate の paths 条件で required ==="
run --files supabase/__tests__/integration/foo.test.ts
assert_eq "$(printf '%s' "$OUT" | jq -r '.route')" "light" "route は light（matchedPaths 無し）"
assert_contains "$(keys_of "$OUT" required)" "rls-idor-integration" "paths 条件で RLS/IDOR 統合が required"
assert_not_contains "$(keys_of "$OUT" required)" "direct-attack" "直接攻撃は required にならない（auth/認可/RLS のパスではない）"

echo "=== scenario 5: hook スクリプト変更 → 対応する *.test.sh が名指しされ、hook 実機発火が required ==="
run --files scripts/check-foo.sh
assert_contains "$(printf '%s' "$OUT" | jq -r '.required[] | select(.key=="hook-regression") | .commands[]')" "bash scripts/check-foo.test.sh" "対応する test.sh をコマンドに出す"
assert_contains "$(keys_of "$OUT" required)" "hook-live" "hook 実機発火が required"
run --files scripts/check-foo.test.sh
assert_contains "$(printf '%s' "$OUT" | jq -r '.required[] | select(.key=="hook-regression") | .commands[]')" "bash scripts/check-foo.test.sh" "test.sh 自体の変更もそのテストを名指し"
assert_contains "$(keys_of "$OUT" not_required)" "hook-live" "test.sh だけなら hook 実機発火は不要"

echo "=== scenario 6: .claude/workflows 変更 → agents baseline・workflow eval が required、aidd-phase2.js なら訓練も昇格 ==="
run --files .claude/workflows/aidd-phase2.js
assert_contains "$(keys_of "$OUT" required)" "agents-baseline" "agents baseline が required"
assert_contains "$(keys_of "$OUT" required)" "workflow-eval" "workflow eval が required"
assert_contains "$(keys_of "$OUT" required)" "fault-injection-drill" "fault injection 訓練が節目から昇格"
assert_not_contains "$(keys_of "$OUT" milestone)" "fault-injection-drill" "昇格した種別は milestone 側に残らない"

echo "=== scenario 7: リスク申告 → 未整備の種別（冪等性）が required になり not-ready が付く ==="
run --files src/components/Foo.tsx --risk retry_possible,contention
assert_contains "$(keys_of "$OUT" required)" "idempotency" "retry_possible で冪等性が required"
assert_contains "$(keys_of "$OUT" required)" "concurrency" "contention で同時実行が required"
assert_eq "$(printf '%s' "$OUT" | jq -r '.required[] | select(.key=="idempotency") | .status')" "not-ready" "未整備の種別は not-ready"
run --files src/components/Foo.tsx --risk authz_change
assert_contains "$(keys_of "$OUT" required)" "rls-idor-integration" "authz_change 申告で RLS/IDOR 統合が required（パスに関係なく）"
assert_contains "$(keys_of "$OUT" required)" "direct-attack" "authz_change 申告で直接攻撃が required"

echo "=== scenario 8: 注文・返却系 migration → 冪等性・同時実行がパスから required ==="
run --files supabase/migrations/20260901_add_loan_return_rpc.sql
assert_contains "$(keys_of "$OUT" required)" "idempotency" "loan_return の migration で冪等性が required"
assert_contains "$(keys_of "$OUT" required)" "concurrency" "loan_return の migration で同時実行が required"

echo "=== scenario 8b: migration のテストファイル（migrations/__tests__/*.test.ts）は冪等性・同時実行のトリガーにしない ==="
run --files supabase/migrations/__tests__/require_aal2_for_order_rpcs.test.ts
assert_contains "$(keys_of "$OUT" not_required)" "idempotency" "テストファイル名の order/rpc では冪等性を要求しない"
assert_contains "$(keys_of "$OUT" not_required)" "concurrency" "テストファイル名の order では同時実行を要求しない"
assert_contains "$(keys_of "$OUT" required)" "rls-idor-integration" "高リスクパス（migrations 配下）としての RLS/IDOR 統合は引き続き required"

echo "=== scenario 9: e2e/ 変更 → 節目の E2E がローカル実行として昇格 ==="
run --files e2e/smoke.spec.ts
assert_contains "$(keys_of "$OUT" required)" "e2e" "E2E が required"
assert_contains "$(printf '%s' "$OUT" | jq -r '.required[] | select(.key=="e2e") | .commands[]')" "npm run test:e2e" "コマンドが出る"

echo "=== scenario 10: ルールに無いパス → unclassified に出る（新しい層の合図） ==="
run --files weird/thing.txt,src/a.ts
assert_eq "$(printf '%s' "$OUT" | jq -r '.unclassified | join(",")')" "weird/thing.txt" "未分類のパスだけが列挙される"

echo "=== scenario 11: table 形式は 04 表の3列で、状態は4値の ⬜ / ➖ だけを使う ==="
run --files src/lib/supabase/orders.ts --format table
assert_contains "$OUT" "| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |" "見出し行"
assert_eq "$(printf '%s\n' "$OUT" | grep -c '^| .* | ⬜ 未実施 | ')" "$(keys_of "$(bash "$SCRIPT" --files src/lib/supabase/orders.ts)" required | wc -l | tr -d ' ')" "⬜ 未実施 の行数 = required の件数"
assert_eq "$(printf '%s\n' "$OUT" | grep '^| ' | grep -v -e '⬜ 未実施' -e '➖ 今回不要' -e '種別（test-matrix.md の行）' -e '^| ---' | wc -l | tr -d ' ')" "0" "⬜ / ➖ 以外の状態の行が無い"
assert_contains "$OUT" "route: deep" "route を末尾に出す"

echo "=== scenario 12: 不正入力は exit 2 で JSON エラー ==="
run --files src/a.ts --risk bogus
assert_eq "$EXIT_CODE" "2" "未知のリスクキーは exit 2"
assert_contains "$OUT" "unknown risk key" "エラー文言"
run --bogus-flag
assert_eq "$EXIT_CODE" "2" "未知のフラグは exit 2"

echo "=== scenario 13: --list-keys / --list-rules は全ルールを出し、label は重複しない ==="
run --list-keys
assert_eq "$EXIT_CODE" "0" "exit 0"
KEY_COUNT="$(printf '%s\n' "$OUT" | grep -c .)"
run --list-rules
assert_eq "$(printf '%s\n' "$OUT" | grep -c .)" "$KEY_COUNT" "--list-rules の行数 = --list-keys の行数"
assert_eq "$(printf '%s\n' "$OUT" | cut -f2 | sort | uniq -d | wc -l | tr -d ' ')" "0" "label（種別名）が重複しない"
assert_eq "$(printf '%s\n' "$OUT" | cut -f3 | grep -v -e '^always$' -e '^on-change$' -e '^milestone$' | wc -l | tr -d ' ')" "0" "timing は3値のみ"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
