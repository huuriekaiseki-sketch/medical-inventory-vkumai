#!/bin/bash
# WHY: issue #444向けのPreToolUse hook(scripts/check-run-manifest-presence.sh)の回帰テスト。
# 合成したtool_name/tool_inputのhook入力JSONを標準入力で渡し、高リスクパスへの書き込み時に
# .aidd/run-manifest.jsonが無ければpermissionDecision: "allow" + additionalContextを
# 返すこと・それ以外は何も出力しないことを確認する。
#
# 実行: bash scripts/check-run-manifest-presence.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-run-manifest-presence.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

run_hook() {
  local input="$1"
  set +e
  OUT="$(printf '%s' "$input" | bash "$SCRIPT")"
  EXIT_CODE=$?
  set -e
}

# manifest無しの隔離リポジトリを用意
NO_MANIFEST_REPO="$(mktemp -d)"
git -C "$NO_MANIFEST_REPO" init -q
mkdir -p "$NO_MANIFEST_REPO/src/lib/supabase"

# manifest有りの隔離リポジトリを用意
WITH_MANIFEST_REPO="$(mktemp -d)"
git -C "$WITH_MANIFEST_REPO" init -q
mkdir -p "$WITH_MANIFEST_REPO/src/lib/supabase" "$WITH_MANIFEST_REPO/.aidd"
echo '{}' > "$WITH_MANIFEST_REPO/.aidd/run-manifest.json"

# issue #444レビュー中に実機で発見した誤検知の回帰テスト用: リポジトリの置き場所自体に
# ドメイン語("inventory")が含まれるケース(このリポジトリ自身が"medical-inventory-vkumai"
# という名前であることに由来する)
INVENTORY_NAMED_PARENT="$(mktemp -d)/medical-inventory-fixture"
mkdir -p "$INVENTORY_NAMED_PARENT"
git -C "$INVENTORY_NAMED_PARENT" init -q

cleanup() { rm -rf "$NO_MANIFEST_REPO" "$WITH_MANIFEST_REPO" "$(dirname "$INVENTORY_NAMED_PARENT")"; }
trap cleanup EXIT

echo "=== scenario 1: 高リスクパス(src/lib/supabase配下) + manifest無し → allow+additionalContext ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Edit", tool_input: {file_path: "src/lib/supabase/client.ts", old_string: "x", new_string: "y"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドが出力される"

echo "=== scenario 2: 高リスクパス + manifest有り → 何も出力しない ==="
input="$(jq -n --arg cwd "$WITH_MANIFEST_REPO" '{tool_name: "Edit", tool_input: {file_path: "src/lib/supabase/client.ts", old_string: "x", new_string: "y"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(manifestが存在するため警告不要)"

echo "=== scenario 3: 低リスクパス(README.md) + manifest無し → 何も出力しない ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Edit", tool_input: {file_path: "README.md", old_string: "x", new_string: "y"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(低リスクパスのため対象外)"

echo "=== scenario 4: supabase/migrations/配下 + manifest無し → allow+additionalContext ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "supabase/migrations/20260101000000_add_x.sql", content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"

echo "=== scenario 5: middleware.ts + manifest無し → allow+additionalContext ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "middleware.ts", content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"

echo "=== scenario 5b: proxy.ts + manifest無し → allow+additionalContext（issue #681。Next.js 16でmiddleware.tsから改名） ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "src/proxy.ts", content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"

echo "=== scenario 6: facility関連ファイル名 + manifest無し → allow+additionalContext ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "src/components/FacilitySelector.tsx", content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"

echo "=== scenario 7: MultiEditツールでも同様に検知する(matcher抜け漏れ防止) ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "MultiEdit", tool_input: {file_path: "src/lib/supabase/queries.ts", edits: [{old_string: "x", new_string: "y"}]}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される"

echo "=== scenario 7b: 絶対パスかつリポジトリ名自体にドメイン語('inventory')を含む + 低リスクな相対パス → 何も出力しない(実機で発見した誤検知の回帰テスト) ==="
input="$(jq -n --arg cwd "$INVENTORY_NAMED_PARENT" --arg fp "$INVENTORY_NAMED_PARENT/README.md" '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(リポジトリ名の'inventory'ではなく相対パスで判定する)"

echo "=== scenario 7c: 絶対パスかつリポジトリ名自体にドメイン語を含む + 高リスクな相対パス → allow+additionalContext(相対パス側は正しく検知する) ==="
input="$(jq -n --arg cwd "$INVENTORY_NAMED_PARENT" --arg fp "$INVENTORY_NAMED_PARENT/src/lib/supabase/client.ts" '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" '"permissionDecision": "allow"' "permissionDecision: allowが出力される(相対パス側のsupabaseで正しく検知)"

echo "=== scenario 7d: 絶対パスがリポジトリの外(REPO_ROOT配下ではない) → 何も出力しない ==="
OUTSIDE_FILE="$(mktemp -d)/inventory-unrelated-scratch-file.ts"
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" --arg fp "$OUTSIDE_FILE" '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(リポジトリ外への書き込みは対象外)"
rm -rf "$(dirname "$OUTSIDE_FILE")"

echo "=== scenario 7e: aidd.config.json が無い環境 → 汎用既定値（auth 等）だけで判定し、facility は対象外（issue #420 v1 セット B2） ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "src/components/FacilitySelector.tsx", content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | AIDD_CONFIG_FILE="$NO_MANIFEST_REPO/none.json" bash "$SCRIPT")"
set -e
assert_empty "$OUT" "設定無しでは facility（固有語）は高リスクにならない"
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "src/lib/auth/session.ts", content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | AIDD_CONFIG_FILE="$NO_MANIFEST_REPO/none.json" bash "$SCRIPT")"
set -e
assert_contains "$OUT" '"permissionDecision": "allow"' "設定無しでも auth（汎用既定）は高リスク"
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "db/migrations/001.sql", content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | AIDD_CONFIG_FILE="$NO_MANIFEST_REPO/none.json" bash "$SCRIPT")"
set -e
assert_contains "$OUT" '"permissionDecision": "allow"' "設定無しでも migration を含むパス（汎用既定）は高リスク"

echo "=== scenario 7f: 導入先の設定（ルートヒント＝hook の cwd 直下）から固有語を足せる ==="
printf '{"risk":{"domainKeywords":["corpus"],"pathPrefixes":["ingest/"]}}\n' > "$NO_MANIFEST_REPO/aidd.config.json"
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "src/corpus/loader.ts", content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | env -u AIDD_CONFIG_FILE bash "$SCRIPT")"
set -e
assert_contains "$OUT" '"permissionDecision": "allow"' "cwd 直下の設定の domainKeywords が効く"
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Write", tool_input: {file_path: "ingest/run.ts", content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | env -u AIDD_CONFIG_FILE bash "$SCRIPT")"
set -e
assert_contains "$OUT" '"permissionDecision": "allow"' "cwd 直下の設定の pathPrefixes が効く"
rm -f "$NO_MANIFEST_REPO/aidd.config.json"

echo "=== scenario 8: Bashツールは対象外(matcherに含まれない) → 何も出力しない ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" '{tool_name: "Bash", tool_input: {command: "cat src/lib/supabase/client.ts"}, cwd: $cwd}')"
run_hook "$input"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である(Bashは対象ツール外)"

echo "=== scenario 9: .claude/settings.jsonのmatcherと本スクリプトのcase文のツール一覧が一致する ==="
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
MATCHER_TOOLS="$(jq -r '.hooks.PreToolUse[] | select(.hooks[].command | endswith("check-run-manifest-presence.sh")) | .matcher' "$SETTINGS_FILE" | tr '|' '\n' | sort)"
CASE_TOOLS="$(grep -oE '^  [A-Za-z]+(\|[A-Za-z]+)*\)' "$SCRIPT" | grep -v '^  \*)' | tr -d ' )' | tr '|' '\n' | sort -u)"
assert_eq "$CASE_TOOLS" "$MATCHER_TOOLS" "settings.jsonのmatcherとcase文のツール一覧(Write/Edit/MultiEdit)が一致する"

echo "=== scenario 10: jq未インストール環境 → fail-open(常にブロックしない設計のためexit 0、issue #636) ==="
input="$(jq -n --arg cwd "$NO_MANIFEST_REPO" --arg fp "$NO_MANIFEST_REPO/src/lib/supabase/client.ts" '{tool_name: "Write", tool_input: {file_path: $fp, content: "x"}, cwd: $cwd}')"
set +e
OUT="$(printf '%s' "$input" | PATH="" /bin/bash "$SCRIPT" 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0(fail-open。本ファイルは元々ブロックしない設計のため他2ゲートと異なりfail-closedにしない)"
assert_empty "$OUT" "出力が空である(警告注入は諦めるが、ブロックはしない)"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
