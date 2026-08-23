#!/bin/bash
# WHY: Codex subagent(.codex/agents/*.toml)のsandbox_mode明示を機械強制する回帰テスト。
# sandbox_modeを指定しないと親セッションの権限(workspace-write等)を継承し、
# レビュー専用・読み取り専用のはずのsubagentが書き込み可能になる（riff-gear実機検証）。
# テンプレート原則6: 全tomlがsandbox_modeを明示し、読み取り専用ロールはread-onlyとする。
#
# 実行: bash scripts/codex-agents-sandbox.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/.codex/agents"

# 読み取り専用であるべきロール（.claude/agents/ の同名ロール定義と対応）
READONLY_ROLES="reviewer sweep-ui sweep-data sweep-db sweep-types completeness-critic judge-panel adversarial-verify proposer"
# 書き込みを担うロール（明示的にworkspace-writeを宣言する）
WRITE_ROLES="implementer integrator contract-writer"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; fail=1; }

echo "=== scenario 1: 読み取り専用ロールのtomlが存在し sandbox_mode = \"read-only\" を明示している ==="
for role in $READONLY_ROLES; do
  toml="$AGENTS_DIR/$role.toml"
  if [ ! -f "$toml" ]; then
    assert_fail "$role.toml が存在しない"
    continue
  fi
  if grep -q 'sandbox_mode = "read-only"' "$toml"; then
    assert_ok "$role.toml は read-only を明示"
  else
    assert_fail "$role.toml に sandbox_mode = \"read-only\" が無い"
  fi
done

echo "=== scenario 2: 書き込み系ロールのtomlが sandbox_mode = \"workspace-write\" を明示している ==="
for role in $WRITE_ROLES; do
  toml="$AGENTS_DIR/$role.toml"
  if [ ! -f "$toml" ]; then
    assert_fail "$role.toml が存在しない"
    continue
  fi
  if grep -q 'sandbox_mode = "workspace-write"' "$toml"; then
    assert_ok "$role.toml は workspace-write を明示"
  else
    assert_fail "$role.toml に sandbox_mode = \"workspace-write\" が無い"
  fi
done

echo "=== scenario 3: .codex/agents/ の全tomlが sandbox_mode を明示している（暗黙の権限継承を許さない） ==="
for toml in "$AGENTS_DIR"/*.toml; do
  [ -e "$toml" ] || continue
  base="$(basename "$toml")"
  if grep -q '^sandbox_mode = ' "$toml"; then
    assert_ok "$base は sandbox_mode を明示"
  else
    assert_fail "$base に sandbox_mode の明示が無い（親権限を暗黙継承してしまう）"
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
