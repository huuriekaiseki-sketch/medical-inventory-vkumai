#!/bin/bash
# WHY: eval-workflow-prompts.shはclaude -pのサブプロセス実行を含み実課金が発生するため、
# EVAL_WORKFLOW_PROMPTS_AGENT_CMDでモックに差し替えてfixture突合ロジック・サーキットブレーカーを
# 実課金なしで回帰テストする。verify-claims.test.shと同じパターン(issue #391)。
#
# 実行: bash scripts/eval-workflow-prompts.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/eval-workflow-prompts.sh"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# --- テスト用の最小fixtureセットを用意する ---
FIXTURES_DIR="$WORKDIR/fixtures"
mkdir -p "$FIXTURES_DIR/sample/case-a" "$FIXTURES_DIR/sample/case-b"
cat > "$FIXTURES_DIR/sample/manifest.json" <<'EOF'
{
  "agentType": "implementer",
  "promptModule": "scripts/eval-fixtures/dummy-prompt.js",
  "promptFn": "buildDummyPrompt",
  "model": "sonnet",
  "jsonSchema": { "type": "object", "properties": { "status": { "type": "string" } }, "required": ["status"] }
}
EOF
echo "spec-a" > "$FIXTURES_DIR/sample/case-a/spec.md"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-a/expected.json"
echo "spec-b" > "$FIXTURES_DIR/sample/case-b/spec.md"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-b/expected.json"
# WHY: promptFnは固定のspecPath文字列("SPEC.md")しか受け取らず、spec.mdの中身の違いは
# プロンプト文字列に反映されない（実際にファイル内容を読むのは本物のclaude -pサブプロセスの
# 中身であり、mockからは見えない）。そのためmockはcase-a/case-bを区別できず、両者に対して
# 常に同一の応答を返す。ケースごとに異なる判定を検証したい場合は、mockの応答ではなく
# expected.json側を書き換えて不一致を作る（scenario 2参照）。

# clone元となるダミーrepo(promptModuleを含む)
DUMMY_REPO="$WORKDIR/dummy-repo"
mkdir -p "$DUMMY_REPO/scripts/eval-fixtures"
(
  cd "$DUMMY_REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "export function buildDummyPrompt(specPath) { return 'prompt-for-' + specPath }" > scripts/eval-fixtures/dummy-prompt.js
  git add -A
  git commit -q -m "init"
)

MOCK_AGENT="$WORKDIR/mock-agent.sh"
MOCK_CALL_LOG="$WORKDIR/call.log"
MOCK_RESPONSE_FILE="$WORKDIR/mock-response.json"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
# WHY: プロンプト本文には改行を含まないためcat単独でappendすると呼び出し回数を
# wc -lで数えられない。1呼び出しにつき1行のマーカーを追記して回数を数えられるようにする。
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected to find: $needle / actual: $haystack)"
    fail=1
  fi
}

run_eval() {
  set +e
  OUT="$(
    EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
    EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$FIXTURES_DIR" \
    EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$WORKDIR/lock" \
    EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
    EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
    MOCK_CALL_LOG="$MOCK_CALL_LOG" \
    MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
    bash "$SCRIPT" sample 2>"$WORKDIR/stderr.tmp"
  )"
  EXIT_CODE=$?
  ERR="$(cat "$WORKDIR/stderr.tmp")"
  set -e
}

echo "=== scenario 1: 全fixtureが期待通り → exit 0 ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
run_eval
assert_eq "$EXIT_CODE" "0" "全fixture合格でexit 0"
assert_eq "$(wc -l < "$MOCK_CALL_LOG" | tr -d ' ')" "2" "case-a/case-bそれぞれ1回ずつ、計2回エージェントが呼ばれる"

echo "=== scenario 2: 1件のstatusが期待と不一致 → exit 1、報告に不一致が含まれる ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "blocked" }' > "$FIXTURES_DIR/sample/case-b/expected.json"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
run_eval
assert_eq "$EXIT_CODE" "1" "case-bはblocked期待だがmockはpassを返すため不一致でexit 1"
assert_contains "$OUT" "case-b" "不一致fixtureの名前が報告に含まれる"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-b/expected.json"

echo "=== scenario 3: エージェント呼び出し自体が失敗(non-zero exit) → 失敗として報告、スクリプト自体はクラッシュしない ==="
rm -f "$MOCK_CALL_LOG"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
exit 1
MOCK_EOF
chmod +x "$MOCK_AGENT"
run_eval
assert_eq "$EXIT_CODE" "1" "エージェント呼び出し失敗時もスクリプトはexit 1で正常終了する(クラッシュしない)"
assert_contains "$OUT" "エージェント実行が失敗" "失敗理由が報告に含まれる"
# 元に戻す
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
# WHY: プロンプト本文には改行を含まないためcat単独でappendすると呼び出し回数を
# wc -lで数えられない。1呼び出しにつき1行のマーカーを追記して回数を数えられるようにする。
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

echo "=== scenario 4: 同時実行数が上限に達している → サーキットブレーカーでexit 1、エージェントを呼ばない ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
LOCK_DIR="$WORKDIR/lock-full"
mkdir -p "$LOCK_DIR"
sleep 60 & DUMMY_PID_1=$!
sleep 60 & DUMMY_PID_2=$!
mkdir -p "$LOCK_DIR/$DUMMY_PID_1" "$LOCK_DIR/$DUMMY_PID_2"
set +e
OUT="$(
  EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
  EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$FIXTURES_DIR" \
  EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$LOCK_DIR" \
  EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
  EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
  MOCK_CALL_LOG="$MOCK_CALL_LOG" \
  MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
  bash "$SCRIPT" sample 2>"$WORKDIR/stderr4.tmp"
)"
EXIT_CODE=$?
set -e
kill "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
wait "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
assert_eq "$EXIT_CODE" "1" "同時実行数上限時はexit 1"
assert_contains "$OUT$( [ -f "$WORKDIR/stderr4.tmp" ] && cat "$WORKDIR/stderr4.tmp" )" "サーキットブレーカー" "サーキットブレーカーが働いた旨が報告される"
if [ -f "$MOCK_CALL_LOG" ]; then
  echo "  NG: サーキットブレーカー発動時はエージェントを呼ばないはずだが呼び出しログが存在する"
  fail=1
else
  echo "  OK: サーキットブレーカー発動時はエージェントを呼ばない(呼び出しログが作られない)"
fi

echo "=== scenario 5: claude -p呼び出しに--setting-sources \"\"と--no-session-persistenceが付いている(静的確認) ==="
RUN_AGENT_BLOCK="$(awk '/^run_agent\(\)/,/^}/' "$SCRIPT")"
assert_contains "$RUN_AGENT_BLOCK" '--setting-sources ""' "claude -p呼び出しに--setting-sources \"\"が付いている(Stop hook再帰発火防止)"
assert_contains "$RUN_AGENT_BLOCK" '--no-session-persistence' "claude -p呼び出しに--no-session-persistenceが付いている"

echo "=== scenario 6: git cloneが失敗する → 当該fixtureをNGとして継続実行し、全体をabortしない(レビュー指摘1) ==="
rm -f "$MOCK_CALL_LOG"
echo '{ "status": "pass" }' > "$FIXTURES_DIR/sample/case-b/expected.json"
echo '{ "status": "pass" }' > "$MOCK_RESPONSE_FILE"
BROKEN_REPO_DIR="$WORKDIR/no-such-repo"
set +e
OUT="$(
  EVAL_WORKFLOW_PROMPTS_REPO_DIR="$BROKEN_REPO_DIR" \
  EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$FIXTURES_DIR" \
  EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$WORKDIR/lock-clone-fail" \
  EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
  EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
  MOCK_CALL_LOG="$MOCK_CALL_LOG" \
  MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
  bash "$SCRIPT" sample 2>"$WORKDIR/stderr6.tmp"
)"
EXIT_CODE=$?
ERR="$(cat "$WORKDIR/stderr6.tmp")"
set -e
assert_eq "$EXIT_CODE" "1" "cloneが失敗するfixtureセットはexit 1"
assert_contains "$OUT$ERR" "case-a" "cloneに失敗したcase-aがNGとして報告される(スキップされていない)"
assert_contains "$OUT$ERR" "case-b" "case-aで落ちずcase-bまで継続実行される(全体abortしていない)"
assert_contains "$OUT$ERR" "cloneに失敗しました" "cloneの失敗理由が報告に含まれる"
if [ -f "$MOCK_CALL_LOG" ]; then
  echo "  NG: cloneに失敗した以上エージェントは呼ばれないはずだが呼び出しログが存在する"
  fail=1
else
  echo "  OK: cloneに失敗した場合はエージェントを呼ばない"
fi

echo "=== scenario 7: プロンプト構築(build-eval-prompt.mjs)が失敗する → 当該fixtureをNGとして継続実行(レビュー指摘1) ==="
rm -f "$MOCK_CALL_LOG"
BROKEN_MANIFEST_FIXTURES_DIR="$WORKDIR/fixtures-broken-manifest"
mkdir -p "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-a" "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-b"
# WHY: promptFnにdummy-prompt.jsが実際にはexportしていない関数名を指定し、
# build-eval-prompt.mjsが`is not exported`でexit 1する状況を再現する。
cat > "$BROKEN_MANIFEST_FIXTURES_DIR/sample/manifest.json" <<'EOF'
{
  "agentType": "implementer",
  "promptModule": "scripts/eval-fixtures/dummy-prompt.js",
  "promptFn": "thisFunctionDoesNotExist",
  "model": "sonnet",
  "jsonSchema": { "type": "object", "properties": { "status": { "type": "string" } }, "required": ["status"] }
}
EOF
echo "spec-a" > "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-a/spec.md"
echo '{ "status": "pass" }' > "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-a/expected.json"
echo "spec-b" > "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-b/spec.md"
echo '{ "status": "pass" }' > "$BROKEN_MANIFEST_FIXTURES_DIR/sample/case-b/expected.json"
set +e
OUT="$(
  EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
  EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$BROKEN_MANIFEST_FIXTURES_DIR" \
  EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$WORKDIR/lock-build-fail" \
  EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
  EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
  MOCK_CALL_LOG="$MOCK_CALL_LOG" \
  MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
  bash "$SCRIPT" sample 2>"$WORKDIR/stderr7.tmp"
)"
EXIT_CODE=$?
ERR="$(cat "$WORKDIR/stderr7.tmp")"
set -e
assert_eq "$EXIT_CODE" "1" "プロンプト構築が失敗するfixtureセットはexit 1"
assert_contains "$OUT$ERR" "case-a" "構築に失敗したcase-aがNGとして報告される(スキップされていない)"
assert_contains "$OUT$ERR" "case-b" "case-aで落ちずcase-bまで継続実行される(全体abortしていない)"
assert_contains "$OUT$ERR" "プロンプトの構築に失敗しました" "プロンプト構築の失敗理由が報告に含まれる"
if [ -f "$MOCK_CALL_LOG" ]; then
  echo "  NG: プロンプト構築に失敗した以上エージェントは呼ばれないはずだが呼び出しログが存在する"
  fail=1
else
  echo "  OK: プロンプト構築に失敗した場合はエージェントを呼ばない"
fi

echo "=== scenario 8: case-*/ディレクトリが1件もない → 0/0合格の誤ったexit 0にせずexit 1にする(レビュー指摘2) ==="
EMPTY_FIXTURES_DIR="$WORKDIR/fixtures-empty"
mkdir -p "$EMPTY_FIXTURES_DIR/sample"
cat > "$EMPTY_FIXTURES_DIR/sample/manifest.json" <<'EOF'
{
  "agentType": "implementer",
  "promptModule": "scripts/eval-fixtures/dummy-prompt.js",
  "promptFn": "buildDummyPrompt",
  "model": "sonnet",
  "jsonSchema": { "type": "object", "properties": { "status": { "type": "string" } }, "required": ["status"] }
}
EOF
set +e
OUT="$(
  EVAL_WORKFLOW_PROMPTS_REPO_DIR="$DUMMY_REPO" \
  EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR="$EMPTY_FIXTURES_DIR" \
  EVAL_WORKFLOW_PROMPTS_LOCK_DIR="$WORKDIR/lock-empty" \
  EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT=2 \
  EVAL_WORKFLOW_PROMPTS_AGENT_CMD="$MOCK_AGENT" \
  MOCK_CALL_LOG="$MOCK_CALL_LOG" \
  MOCK_RESPONSE_FILE="$MOCK_RESPONSE_FILE" \
  bash "$SCRIPT" sample 2>"$WORKDIR/stderr8.tmp"
)"
EXIT_CODE=$?
ERR="$(cat "$WORKDIR/stderr8.tmp")"
set -e
assert_eq "$EXIT_CODE" "1" "case-*/が1件も無い場合はexit 1(0/0合格のexit 0にしない)"
assert_contains "$ERR" "case-*/ ディレクトリが1件も見つかりません" "設定ミスを示すエラーメッセージがstderrに出る"

echo "=== scenario 9: タイムアウト時にプロセスグループごとkillする実装になっている(静的確認、issue #391 Task6) ==="
RUN_AGENT_WITH_TIMEOUT_BLOCK="$(awk '/^run_agent_with_timeout\(\)/,/^}/' "$SCRIPT")"
assert_contains "$RUN_AGENT_WITH_TIMEOUT_BLOCK" 'kill -- "-$pid"' "タイムアウト時にプロセスグループ全体をkillする実装になっている(単一PIDのkillに退行するとimplementerの子プロセスが停止せず残る)"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
