#!/bin/bash
# WHY: issue #429向けの機械トリガー(scripts/check-agent-baseline-freshness.sh)の回帰テスト。
# 一時gitリポジトリでagents設定変更のみのコミット・baseline同時更新のコミットを作り、
# 期待通りに警告が出る/出ないことを確認する。
#
# 実行: bash scripts/check-agent-baseline-freshness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-agent-baseline-freshness.sh"

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

mkdir -p .claude/agents docs/agents/baselines
cat > .claude/agents/sweep-ui.md <<'EOF'
---
name: sweep-ui
model: haiku
---
body
EOF
git add .
git commit --quiet -m "base"

echo "=== scenario 1: agents設定のみ変更 → warning ==="
cat > .claude/agents/sweep-ui.md <<'EOF'
---
name: sweep-ui
model: haiku
effort: low
---
body
EOF
git add .
git commit --quiet -m "add effort only"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_contains "$OUT" "::warning::" "警告が出る"

echo "=== scenario 2: agents設定 + baseline更新を同時コミット → OKのみ ==="
cat > .claude/agents/sweep-ui.md <<'EOF'
---
name: sweep-ui
model: haiku
effort: medium
---
body
EOF
echo '{"note":"test"}' > docs/agents/baselines/2026-07-16.json
git add .
git commit --quiet -m "change effort + add baseline"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_not_contains "$OUT" "::warning::" "警告が出ない（baseline同時更新済み）"

echo "=== scenario 3: agents設定に無関係な変更のみ → 何も出ない ==="
echo "# unrelated" >> README.md
git add .
git commit --quiet -m "unrelated doc change"
OUT="$(bash "$SCRIPT" HEAD~1 HEAD)"
assert_not_contains "$OUT" "::warning::" "警告が出ない（設定変更なし）"

cd - > /dev/null
rm -rf "$TMP_REPO"

if [ "$fail" -ne 0 ]; then
  echo "FAIL"
  exit 1
fi
echo "PASS"
