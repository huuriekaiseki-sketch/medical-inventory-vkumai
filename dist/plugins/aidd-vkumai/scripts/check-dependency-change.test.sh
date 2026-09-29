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
  if grep -qF -- "$needle" <<<"$haystack"; then echo "  OK: $label"; else echo "  NG: $label"; echo "      expected: $needle"; echo "      actual: $haystack"; fail=1; fi
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

# --- Codex のファイル編集（apply_patch）。docs/specs/codex-hook-parity/01-apply-patch.md ---
# WHY: Codex はファイル編集を tool_name: "apply_patch" で渡し、パスは tool_input.command（パッチ本文）の
# ヘッダ行に入る。scenario 3 の Edit / Write + file_path は Claude の形で、Codex では来ない。
run_patch() { # $1=パッチ本文 $2=対象スクリプト（省略時は判定本体）
  set +e
  OUT="$(jq -n --arg c "$1" '{tool_name: "apply_patch", tool_input: {command: $c}, cwd: "/repo"}' | bash "${2:-$SCRIPT}" 2>/dev/null)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 7: apply_patch で package.json / package-lock.json を触る → ask ==="
run_patch $'*** Begin Patch\n*** Update File: package.json\n@@\n-  "a": "1"\n+  "a": "1",\n+  "left-pad": "1.3.0"\n*** End Patch'
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_eq "$(decision)" "ask" "Update File package.json は ask"
assert_contains "$OUT" "package.json への直接編集" "理由は Edit / Write のときと同じ文"
run_patch $'*** Begin Patch\n*** Add File: web/package.json\n+{}\n*** End Patch'
assert_eq "$(decision)" "ask" "サブディレクトリの package.json も ask"
run_patch $'*** Begin Patch\n*** Delete File: package-lock.json\n*** End Patch'
assert_eq "$(decision)" "ask" "Delete File package-lock.json は ask"
run_patch $'*** Begin Patch\n*** Update File: tmp/p.json\n*** Move to: package.json\n@@\n-1\n+2\n*** End Patch'
assert_eq "$(decision)" "ask" "Move to（移動先が package.json）は ask"
run_patch $'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** Update File: package.json\n@@\n-1\n+2\n*** Update File: docs/b.md\n@@\n-1\n+2\n*** End Patch'
assert_eq "$(decision)" "ask" "複数ファイルのうち 1 つだけ該当でも全体が ask"
run_patch $'*** Begin Patch\r\n*** Update File: package.json\r\n@@\r\n-1\r\n+2\r\n*** End Patch\r\n'
assert_eq "$(decision)" "ask" "行末が CRLF でも ask"

echo "=== scenario 8: apply_patch の対照 → 何も出ない ==="
run_patch $'*** Begin Patch\n*** Update File: src/lib/package.ts\n@@\n-1\n+2\n*** End Patch'
assert_empty "$OUT" "package.json 以外は沈黙"
run_patch $'*** Begin Patch\n*** Update File: docs/packages.json\n@@\n-1\n+2\n*** End Patch'
assert_empty "$OUT" "似た名前（packages.json）は沈黙"
run_patch $'*** Begin Patch\n*** Update File: docs/setup.md\n@@\n-old\n+package.json に scripts を足す\n+*** Update File: package.json\n*** End Patch'
assert_empty "$OUT" "本文（+ 行）にファイル名とヘッダもどきが出るだけでは沈黙"
run_patch 'ヘッダの無い文字列'
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "ヘッダが 1 行も無ければ沈黙（全編集を止めない）"

echo "=== scenario 9: Codex 用ラッパー経由の apply_patch → deny ==="
run_patch $'*** Begin Patch\n*** Update File: package.json\n@@\n-1\n+2\n*** End Patch' "$CODEX_WRAPPER"
assert_eq "$(decision)" "deny" "ask → deny"
assert_contains "$OUT" "Codexはask未対応" "Bash で止めたときと同じ読み替えの注記が付く"
run_patch $'*** Begin Patch\n*** Update File: src/a.ts\n@@\n-1\n+2\n*** End Patch' "$CODEX_WRAPPER"
assert_empty "$OUT" "無関係なパッチは沈黙のまま"

# --- 判定本体が欠けた・壊れたときは止める側に倒す。docs/specs/codex-hook-parity/04-wrapper-fail-closed.md ---
# WHY: ラッパーは判定本体に丸投げしている。本体が無い・失敗する・読めない結果を返すとき、
# ラッパーは rc=127 などで抜けるだけだった（2026-09-29 実測）。jq 不在のときと同じ exit 2 に揃える。
WRAP_DIR="$WORK_DIR/wrap"
mkdir -p "$WRAP_DIR"
GUARD_NAME="check-dependency-change.sh"
run_with_guard() { # $1=判定本体の中身（空なら置かない）
  rm -f "$WRAP_DIR/$GUARD_NAME"
  cp "$CODEX_WRAPPER" "$WRAP_DIR/wrapper.sh"
  [ -n "$1" ] && printf '%s\n' "$1" > "$WRAP_DIR/$GUARD_NAME"
  set +e
  OUT="$(jq -n '{tool_name: "Bash", tool_input: {command: "npm install lodash"}}' | bash "$WRAP_DIR/wrapper.sh" 2>"$WRAP_DIR/err.txt")"
  EXIT_CODE=$?
  set -e
  ERR="$(cat "$WRAP_DIR/err.txt")"
}

echo "=== scenario 10: ラッパーの判定本体が無い・失敗・読めない出力 → exit 2 ==="
run_with_guard ""
assert_eq "$EXIT_CODE" "2" "判定本体が無ければ exit 2"
assert_contains "$ERR" "$GUARD_NAME" "何が欠けているかを名指しする"
assert_contains "$ERR" "入れ直し" "直し方が書いてある"
run_with_guard 'cat >/dev/null; exit 1'
assert_eq "$EXIT_CODE" "2" "exit 1 で終わる本体でも exit 2"
run_with_guard 'cat >/dev/null; echo "not json {"'
assert_eq "$EXIT_CODE" "2" "JSON でない出力は exit 2"
assert_empty "$OUT" "壊れた出力をそのまま Codex へ渡さない"

echo "=== scenario 11: ラッパーの判定本体が沈黙 → そのまま通す（対照） ==="
run_with_guard 'cat >/dev/null; exit 0'
assert_eq "$EXIT_CODE" "0" "沈黙は exit 0"
assert_empty "$OUT" "沈黙は沈黙のまま"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
