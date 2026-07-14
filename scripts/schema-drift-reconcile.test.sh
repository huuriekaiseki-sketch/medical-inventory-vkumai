#!/bin/bash
# WHY: .github/workflows/schema-drift-check.ymlのIssue作成/重複防止/クローズロジックは
# GitHub Actions上でしか動かないbash+jqのため、通常のvitestでは検証できない。
# 4観点レビュー（issue #305 Phase 5）で「ドライラン確認済みと主張しているが再現できる
# テストが無い」と指摘されたため、実際のワークフローと同じjqロジックをここに複製し、
# gh CLIをスタブ化して回帰テストとして固定する。
#
# 実行: bash scripts/schema-drift-reconcile.test.sh
set -euo pipefail

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual output: $haystack"
    fail=1
  fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  NG: $label (should NOT contain: $needle)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

# .github/workflows/schema-drift-check.yml の "Fetch" ステップと同じtitle生成ロジック
cat > drift_raw.json <<'EOF'
[
  {"drift_type": "table_added", "object_name": "zz_test", "detected_at": "2026-07-14T08:00:00Z"},
  {"drift_type": "rls_disabled", "object_name": "products", "detected_at": "2026-07-14T08:00:00Z"}
]
EOF

jq '[.[] | . + {
      title: (if .drift_type == "rls_disabled"
              then "[schema-drift][priority:high] " + .drift_type + ": " + .object_name
              else "[schema-drift] " + .drift_type + ": " + .object_name end)
    }]' drift_raw.json > drift.json
jq -r '.[].title' drift.json > expected_titles.txt

cat > open_issues.json <<'EOF'
[
  {"title": "[schema-drift] table_added: zz_test", "number": 100},
  {"title": "[schema-drift] table_removed: old_table", "number": 101}
]
EOF

# gh をスタブ化して呼び出し内容だけ記録する（.github/workflows/schema-drift-check.yml と同じ
# Reconcileロジックをここに複製。ワークフロー本体を変更したら、この複製も追随させること）
gh() { echo "GH_CALL: $*"; }
export -f gh

create_output=""
while IFS= read -r title; do
  [ -z "$title" ] && continue
  if jq -e --arg t "$title" 'any(.[]; .title == $t)' open_issues.json > /dev/null; then
    continue
  fi
  row=$(jq -c --arg t "$title" 'map(select(.title == $t)) | .[0]' drift.json)
  drift_type=$(echo "$row" | jq -r '.drift_type')
  object_name=$(echo "$row" | jq -r '.object_name')
  create_output="${create_output}CREATE title=${title} drift_type=${drift_type} object_name=${object_name}
"
done < expected_titles.txt

close_output=""
jq -r '.[].title' open_issues.json | while IFS= read -r title; do
  [ -z "$title" ] && continue
  if grep -qxF "$title" expected_titles.txt; then
    continue
  fi
  number=$(jq -r --arg t "$title" 'map(select(.title == $t)) | .[0].number' open_issues.json)
  echo "CLOSE number=${number} title=${title}" >> close_output.txt
done
[ -f close_output.txt ] && close_output=$(cat close_output.txt)

echo "=== test: 既存openなドリフトは重複作成しない ==="
assert_not_contains "$create_output" "title=[schema-drift] table_added: zz_test" "table_added:zz_testは新規作成されない"

echo "=== test: 未解決かつopen issue無しのドリフトは新規作成される ==="
assert_contains "$create_output" "title=[schema-drift][priority:high] rls_disabled: products" "rls_disabled:productsが優先度high付きで新規作成対象になる"

echo "=== test: 未解決一覧に存在しなくなったopen issueはクローズされる ==="
assert_contains "$close_output" "number=101" "table_removed:old_table(issue #101)がクローズ対象になる"

echo "=== test: 引き続き未解決のissueはクローズ対象に含まれない ==="
assert_not_contains "$close_output" "number=100" "table_added:zz_test(issue #100)はクローズされない"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
