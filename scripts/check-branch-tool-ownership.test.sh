#!/bin/bash
# WHY: scripts/check-branch-tool-ownership.sh の回帰テスト。
# 「Claude Code用worktree/ブランチとCodex用worktree/codex/*ブランチを分離し、
# 同一worktreeで並行作業しない」ルール（docs/agents/parallel-agent-work.md）は
# 自然言語のみでは強制力が無い（issue #339）。ブランチ命名規約
# （codex/* = Codex専用、claude/* = Claude Code専用）との取り違えをSessionStartで
# 機械警告する部分検知を固定する。
#
# 実行: bash scripts/check-branch-tool-ownership.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-branch-tool-ownership.sh"

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

# サンドボックスgitリポジトリを用意（実リポジトリの状態に依存しない）
SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
git -C "$SANDBOX" init -q -b main
git -C "$SANDBOX" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m init

run_check() {
  local tool="$1" branch="$2"
  git -C "$SANDBOX" checkout -q -B "$branch"
  set +e
  OUT="$(cd "$SANDBOX" && bash "$SCRIPT" "$tool")"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: Claude Codeがcodex/*ブランチを開いた → 警告 ==="
run_check claude codex/aidd-port
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageが出力される"
assert_contains "$OUT" "codex/aidd-port" "ブランチ名が警告に含まれる"

echo "=== scenario 2: Codexがclaude/*ブランチを開いた → 警告 ==="
run_check codex claude/feature-x
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageが出力される"

echo "=== scenario 3: Claude Codeがclaude/*ブランチ → 沈黙 ==="
run_check claude claude/feature-x
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 4: Codexがcodex/*ブランチ → 沈黙 ==="
run_check codex codex/aidd-port
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 5: どちらの所有でもない一般ブランチ（feature/xxx） → 沈黙（誤検知しない） ==="
run_check claude feature/general-work
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"
run_check codex feature/general-work
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: ツール名引数なし → 沈黙（判定不能時は誤警告しない） ==="
run_check "" codex/aidd-port
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
