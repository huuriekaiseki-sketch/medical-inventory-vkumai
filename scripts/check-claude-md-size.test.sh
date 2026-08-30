#!/bin/bash
# WHY: scripts/check-claude-md-size.sh(SessionStart hook)の回帰テスト。
# CLAUDE.md / docs/agents/common.mdの行数が閾値を超えたら警告し、超えなければ
# 何も出力しないことを確認する。CLAUDE_PROJECT_DIR/CLAUDE_MD_LINE_LIMIT/
# COMMON_MD_LINE_LIMITでテスト用に差し替える（本物のCLAUDE.mdを書き換えないため）。
#
# 実行: bash scripts/check-claude-md-size.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-claude-md-size.sh"

fail=0
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
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

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT
mkdir -p "$TMPDIR_TEST/docs/agents"

echo "=== scenario 1: どちらも閾値以下 → 何も出力しない ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_empty "$OUT" "行数が閾値以下なら警告なし"

echo "=== scenario 2: CLAUDE.mdが閾値超過 → 警告する ==="
seq 1 250 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "CLAUDE.md" "CLAUDE.mdへの言及がある"

echo "=== scenario 3: common.mdが閾値超過 → 警告する ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 350 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_contains "$OUT" "common.md" "common.mdへの言及がある"

echo "=== scenario 4: 環境変数で閾値を変更できる ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" CLAUDE_MD_LINE_LIMIT=10 bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "閾値を下げると50行でも警告される"

echo "=== scenario 5: ファイルが存在しない → クラッシュせず何も出力しない ==="
EMPTY_DIR="$(mktemp -d)"
OUT="$(CLAUDE_PROJECT_DIR="$EMPTY_DIR" bash "$SCRIPT")"
assert_empty "$OUT" "ファイル不在でもクラッシュしない"
rm -rf "$EMPTY_DIR"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
