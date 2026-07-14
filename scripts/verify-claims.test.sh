#!/bin/bash
# WHY: issue #343（検証サブエージェント/Stop hook自動裏取り）向けのverify-claims.shは
# claude -p のサブプロセス実行を含みコストがかかるため、VERIFY_CLAIMS_VERIFIER_CMDで
# モックに差し替えて合成hook入力で回帰テストする。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md
#
# 実行: bash scripts/verify-claims.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/verify-claims.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

REPO="$WORKDIR/repo"
mkdir -p "$REPO"
(
  cd "$REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "line1" > file.txt
  git add file.txt
  git commit -q -m "init"
)

STATE_DIR="$WORKDIR/state"
MOCK_VERIFIER="$WORKDIR/mock-verifier.sh"
MOCK_CALL_LOG="$WORKDIR/call.log"
MOCK_FINDINGS_FILE="$WORKDIR/findings.json"

cat > "$MOCK_VERIFIER" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
if [ "${MOCK_SHOULD_FAIL:-0}" = "1" ]; then
  exit 1
fi
cat "$MOCK_FINDINGS_FILE"
MOCK_EOF
chmod +x "$MOCK_VERIFIER"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
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

# 呼び出しヘルパー: $1=session_id $2=uncommitted diffの有無(yes/no) 戻り値はグローバル変数で受け渡す
STDOUT_OUT=""
STDERR_OUT=""
EXIT_CODE=0
run_hook() {
  local session_id="$1"
  local input
  input="$(jq -n --arg sid "$session_id" --arg tp "$WORKDIR/no-transcript.jsonl" '{session_id: $sid, transcript_path: $tp}')"
  local err_file="$WORKDIR/stderr.tmp"
  set +e
  STDOUT_OUT="$(
    cd "$REPO"
    printf '%s' "$input" | \
      VERIFY_CLAIMS_REPO_DIR="$REPO" \
      VERIFY_CLAIMS_STATE_DIR="$STATE_DIR" \
      VERIFY_CLAIMS_MAX_RETRIES=3 \
      VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
      MOCK_CALL_LOG="$MOCK_CALL_LOG" \
      MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
      MOCK_SHOULD_FAIL="${MOCK_SHOULD_FAIL:-0}" \
      bash "$SCRIPT" 2>"$err_file"
  )"
  EXIT_CODE=$?
  STDERR_OUT="$(cat "$err_file")"
  set -e
}

call_count() {
  if [ -f "$MOCK_CALL_LOG" ]; then wc -l < "$MOCK_CALL_LOG" | tr -d ' '; else echo 0; fi
}

echo "=== scenario 1: diff無し → 即pass ==="
rm -f "$MOCK_CALL_LOG"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
run_hook "s1"
assert_eq "$EXIT_CODE" "0" "diff無しはexit 0"

echo "=== scenario 2: diff一致・前回pass → 即pass(LLM呼び出し無し) ==="
rm -f "$MOCK_CALL_LOG"
echo "line2" >> "$REPO/file.txt"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
run_hook "s2"
assert_eq "$EXIT_CODE" "0" "1回目(新規diff)はpass"
assert_eq "$(call_count)" "1" "1回目は検証エージェントが1回呼ばれる"
run_hook "s2"
assert_eq "$EXIT_CODE" "0" "2回目(同一diff)もpass"
assert_eq "$(call_count)" "1" "2回目は検証エージェントが呼ばれない(回数据え置き)"

echo "=== scenario 3: diff一致・前回blocked → LLM呼び出し無しでretry_count+1、再ブロック ==="
rm -f "$MOCK_CALL_LOG"
echo "line3" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "行番号の不一致", "evidence": "file.txt:99"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s3"
assert_eq "$EXIT_CODE" "2" "1回目(新規diff・critical)はブロック"
assert_eq "$(call_count)" "1" "1回目は検証エージェントが1回呼ばれる"
run_hook "s3"
assert_eq "$EXIT_CODE" "2" "2回目(同一diff未解消)も再ブロック"
assert_eq "$(call_count)" "1" "2回目は検証エージェントが呼ばれない(LLM呼び出し無しでretry消費)"
RETRY_COUNT="$(jq -r '.retry_count' "$STATE_DIR/s3.json")"
assert_eq "$RETRY_COUNT" "2" "retry_countが2まで進む"

echo "=== scenario 4: diff不一致・critical finding → ブロック、状態ファイルに記録 ==="
rm -f "$MOCK_CALL_LOG"
echo "line4" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "important", "description": "環境変数名の不一致", "evidence": "src/foo.ts:10"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s4"
assert_eq "$EXIT_CODE" "2" "critical/important findingでブロック"
assert_contains "$STDERR_OUT" "環境変数名の不一致" "指摘内容がstderrに出力される"
VERDICT="$(jq -r '.last_verdict' "$STATE_DIR/s4.json")"
assert_eq "$VERDICT" "blocked" "状態ファイルにblockedが記録される"

echo "=== scenario 5: retry_countが上限を超える → ブロック継続、エスケープハッチ案内 ==="
rm -f "$MOCK_CALL_LOG"
echo "line5" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "解消されない指摘", "evidence": "x:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s5"   # retry 1
run_hook "s5"   # retry 2 (diff不変)
run_hook "s5"   # retry 3 (diff不変)
run_hook "s5"   # retry 4 → 上限超過
assert_eq "$EXIT_CODE" "2" "上限超過後もブロック継続"
assert_contains "$STDERR_OUT" "touch" "エスケープハッチ(.skipマーカー作成方法)の案内が出力される"
assert_contains "$STDERR_OUT" "s5.skip" "案内にセッション固有のskipマーカーパスが含まれる"

echo "=== scenario 6: .skipマーカーあり → 無条件pass、マーカー削除 ==="
rm -f "$MOCK_CALL_LOG"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/s6.skip"
run_hook "s6"
assert_eq "$EXIT_CODE" "0" ".skipマーカーがあれば無条件pass"
assert_eq "$(call_count)" "0" ".skipマーカー時は検証エージェントを呼ばない"
assert_contains "$STDOUT_OUT" "手動オーバーライド" "オーバーライド使用がsystemMessageに記録される"
if [ -f "$STATE_DIR/s6.skip" ]; then
  echo "  NG: .skipマーカーが消費(削除)されていない"
  fail=1
else
  echo "  OK: .skipマーカーが消費(削除)される"
fi

echo "=== scenario 7: 検証プロセス自体が失敗 → fail-openでpass ==="
rm -f "$MOCK_CALL_LOG"
echo "line7" >> "$REPO/file.txt"
MOCK_SHOULD_FAIL=1
run_hook "s7"
MOCK_SHOULD_FAIL=0
assert_eq "$EXIT_CODE" "0" "検証プロセス失敗時はfail-openでexit 0"
assert_contains "$STDOUT_OUT" "実行に失敗" "fail-openの旨がsystemMessageに記録される"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
