#!/bin/bash
# WHY: scripts/check-dependency-change.sh（依存変更を人間確認に強制する PreToolUse ask hook）と
# scripts/codex-dependency-change-deny.sh（Codex 用 ask→deny 変換）の回帰テスト。
# 「入れられないようにする」側（ask が出る）と「日常の npm ci / 読み取りを邪魔しない」側
# （何も出ない）の両方を固定する。
#
# 実行: bash scripts/check-dependency-change.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-dependency-change.sh"
CODEX_WRAPPER="$SCRIPT_DIR/codex-dependency-change-deny.sh"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then echo "  OK: $label"; else echo "  NG: $label (expected=$expected actual=$actual)"; fail=1; fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  OK: $label"; else echo "  NG: $label"; echo "      expected: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then echo "  OK: $label"; else echo "  NG: $label (actual=$actual)"; fail=1; fi
}

run_bash() { # $1=command
  set +e
  OUT="$(jq -n --arg c "$1" '{tool_name: "Bash", tool_input: {command: $c}}' | bash "$SCRIPT" 2>/dev/null)"
  EXIT_CODE=$?
  set -e
}
run_file() { # $1=tool $2=file_path
  set +e
  OUT="$(jq -n --arg t "$1" --arg p "$2" '{tool_name: $t, tool_input: {file_path: $p}}' | bash "$SCRIPT" 2>/dev/null)"
  EXIT_CODE=$?
  set -e
}
decision() { printf '%s' "$OUT" | jq -r '.hookSpecificOutput.permissionDecision // empty'; }

echo "=== scenario 1: 依存を足すコマンド → ask ==="
for cmd in 'npm install lodash' 'npm i -D vitest-mock-extended' 'npm add left-pad@1.3.0' 'npm uninstall react' 'npm update next' \
           'yarn add dayjs' 'pnpm add zod' 'cd sub && npm install foo' 'echo start; npm install bar' 'OUT=$(npm install baz)' \
           '/opt/homebrew/bin/npm install qux'; do
  run_bash "$cmd"
  assert_eq "$EXIT_CODE" "0" "exit 0: $cmd"
  assert_eq "$(decision)" "ask" "ask: $cmd"
done
run_bash 'npm install lodash'
assert_contains "$OUT" "用途と代替案" "理由に報告項目（用途・代替案）が含まれる"
assert_contains "$OUT" "npm audit --omit=dev --audit-level=high" "理由に実行後の確認コマンドが含まれる"

echo "=== scenario 2: lockfile どおりの入れ直し・読み取り系 → 何も出ない ==="
for cmd in 'npm ci' 'npm install' 'npm install --package-lock-only' 'npm ci --dry-run' 'npm run build' 'npm test' \
           'npm audit --omit=dev --audit-level=high' 'npm ls lodash' 'npm explain sharp' 'npm view zod version' \
           'git grep "npm install foo"' 'grep -rn "npm install foo" docs' 'echo "npm install foo"' 'which npm' \
           'npx playwright install --with-deps chromium' 'node scripts/x.js'; do
  run_bash "$cmd"
  assert_eq "$EXIT_CODE" "0" "exit 0: $cmd"
  assert_empty "$OUT" "沈黙: $cmd"
done

echo "=== scenario 3: package.json / package-lock.json への書き込み → ask、他ファイルは沈黙 ==="
run_file Edit "/repo/package.json"
assert_eq "$(decision)" "ask" "Edit package.json は ask"
run_file Write "/repo/package-lock.json"
assert_eq "$(decision)" "ask" "Write package-lock.json は ask"
run_file MultiEdit "package.json"
assert_eq "$(decision)" "ask" "相対パスの package.json も ask"
run_file Edit "/repo/src/lib/package.ts"
assert_empty "$OUT" "package.json 以外は沈黙"
run_file Edit "/repo/docs/packages.json"
assert_empty "$OUT" "似た名前（packages.json）は沈黙"

echo "=== scenario 4: 対象外ツール → 沈黙 ==="
set +e
OUT="$(jq -n '{tool_name: "Read", tool_input: {file_path: "/repo/package.json"}}' | bash "$SCRIPT" 2>/dev/null)"
set -e
assert_empty "$OUT" "Read は対象外"

echo "=== scenario 5: jq 不在 → fail-closed（exit 2） ==="
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
mkdir -p "$WORK_DIR/bin"
for b in bash sed awk tr basename cat printf; do
  p="$(command -v "$b" 2>/dev/null || true)"; [ -n "$p" ] && ln -sf "$p" "$WORK_DIR/bin/$b"
done
set +e
OUT="$(printf '{"tool_name":"Bash","tool_input":{"command":"npm install x"}}' | PATH="$WORK_DIR/bin" bash "$SCRIPT" 2>/dev/null)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "jq 不在では exit 2 で止まる（fail-open にしない）"

echo "=== scenario 6: Codex 用ラッパーは ask を deny に読み替え、沈黙はそのまま ==="
set +e
OUT="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm install lodash"}}' | bash "$CODEX_WRAPPER" 2>/dev/null)"
set -e
assert_eq "$(decision)" "deny" "ask → deny"
assert_contains "$OUT" "Codexはask未対応" "読み替えの注記が付く"
set +e
OUT="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm ci"}}' | bash "$CODEX_WRAPPER" 2>/dev/null)"
set -e
assert_empty "$OUT" "沈黙はそのまま"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
