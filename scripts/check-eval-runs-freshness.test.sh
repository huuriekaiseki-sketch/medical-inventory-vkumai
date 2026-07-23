#!/bin/bash
# WHY: issue #496向けの機械トリガー(scripts/check-eval-runs-freshness.sh)の回帰テスト。
# 一時gitリポジトリでworkflows変更のみのコミット・eval-runs.jsonl同時更新のコミットを作り、
# 期待通りに警告が出る/出ないことを確認する。check-agent-baseline-freshness.test.shと同型。
#
# 実行: bash scripts/check-eval-runs-freshness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-eval-runs-freshness.sh"

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
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label (見つかってはいけない文字列が見つかった)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

TMP_REPO="$(mktemp -d)"
cd "$TMP_REPO"
git init --quiet
git config user.email "test@example.com"
git config user.name "test"

mkdir -p .claude/workflows docs/agents
cat > .claude/workflows/aidd-phase2.js <<'EOF'
export const meta = { name: "aidd-phase2" }
EOF
echo "[]" > docs/agents/eval-runs.jsonl
git add .
git commit --quiet -m "base"

echo "=== scenario 1: workflowsのみ変更 → warning ==="
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// prompt change
EOF
git add .
git commit --quiet -m "change workflow prompt"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_contains "$OUT" "::warning::" "警告が出る"

echo "=== scenario 2: workflows変更 + eval-runs.jsonl更新を同時コミット → OKのみ ==="
cat >> .claude/workflows/aidd-phase2.js <<'EOF'
// another change
EOF
echo '{"timestamp":"2026-07-23T00:00:00Z","script":"eval-workflow-prompts","fixtureSet":"db-impl","pass":4,"total":4}' >> docs/agents/eval-runs.jsonl
git add .
git commit --quiet -m "change workflow prompt + record eval run"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_not_contains "$OUT" "::warning::" "警告が出ない（eval-runs.jsonl同時更新済み）"

echo "=== scenario 3: workflowsに無関係な変更のみ → 何も出ない ==="
echo "# unrelated" >> README.md
git add .
git commit --quiet -m "unrelated doc change"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_not_contains "$OUT" "::warning::" "警告が出ない（workflows変更なし）"

echo "=== scenario 4: .claude/workflows/lib/配下(プロンプト正本の切り出し先)の変更も対象になる ==="
mkdir -p .claude/workflows/lib/prompts
echo "export const x = 1" > .claude/workflows/lib/prompts/db-impl.js
git add .
git commit --quiet -m "change prompt source of truth in lib/"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_contains "$OUT" "::warning::" "警告が出る（lib/prompts/配下もプロンプト正本のため検知対象）"

cd - > /dev/null
rm -rf "$TMP_REPO"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
