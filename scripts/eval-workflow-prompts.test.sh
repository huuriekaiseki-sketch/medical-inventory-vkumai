#!/bin/bash
# WHY: eval-workflow-prompts.shはclaude -pのサブプロセス実行を含みコストがかかるため、
# EVAL_WORKFLOW_VERIFIER_CMDでモックに差し替えてハーネス自体（fixtureループ・JSON解析・
# 判定・サーキットブレーカー）を回帰テストする（verify-claims.test.shと同じパターン、issue #391）。
#
# 実行: bash scripts/eval-workflow-prompts.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/eval-workflow-prompts.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

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
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

# モックverifier: cwd(=fixtureごとの隔離ディレクトリ)のSPEC.mdの内容からfixtureを判別し、
# あらかじめ用意した想定回答を返す。MOCK_WRONG_FIXTUREを指定すると、そのfixtureだけ
# わざと誤ったstatusを返す（regression検知の確認用）。
MOCK_VERIFIER="$WORKDIR/mock-verifier.sh"
cat > "$MOCK_VERIFIER" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
SPEC_CONTENT="$(cat SPEC.md 2>/dev/null || echo "")"
STATUS=""
if printf '%s' "$SPEC_CONTENT" | grep -q "expiry_date"; then
  STATUS="pass"
  if [ "${MOCK_WRONG_FIXTURE:-}" = "db-change" ]; then STATUS="blocked"; fi
elif printf '%s' "$SPEC_CONTENT" | grep -q "該当なし"; then
  STATUS="pass"
  if [ "${MOCK_WRONG_FIXTURE:-}" = "no-db-change-explicit" ]; then STATUS="blocked"; fi
else
  STATUS="blocked"
  if [ "${MOCK_WRONG_FIXTURE:-}" = "db-silent" ]; then STATUS="pass"; fi
fi
printf '{"status": "%s", "detail": "mock"}' "$STATUS"
MOCK_EOF
chmod +x "$MOCK_VERIFIER"

run_eval() {
  local lock_dir="$1"
  set +e
  OUTPUT="$(
    EVAL_WORKFLOW_VERIFIER_CMD="$MOCK_VERIFIER" \
    EVAL_WORKFLOW_LOCK_DIR="$lock_dir" \
    EVAL_WORKFLOW_MAX_CONCURRENT="2" \
    EVAL_WORKFLOW_WORKDIR="$WORKDIR/isolated-$$" \
    "$SCRIPT" 2>&1
  )"
  EXIT_CODE=$?
  set -e
}

echo "--- ケース1: 全fixtureが期待通り(pass/pass/blocked) ---"
run_eval "$WORKDIR/lock1"
assert_eq "$EXIT_CODE" "0" "全fixture一致時はexit 0"
assert_contains "$OUTPUT" "OK: db-change.md - expected=pass actual=pass" "db-change.mdがpass判定"
assert_contains "$OUTPUT" "OK: no-db-change-explicit.md - expected=pass actual=pass" "no-db-change-explicit.mdがpass判定"
assert_contains "$OUTPUT" "OK: db-silent.md - expected=blocked actual=blocked" "db-silent.mdがblocked判定"

echo "--- ケース2: db-silent.mdが誤ってpass判定される回帰(issue #389の再発) ---"
set +e
OUTPUT2="$(
  EVAL_WORKFLOW_VERIFIER_CMD="$MOCK_VERIFIER" \
  EVAL_WORKFLOW_LOCK_DIR="$WORKDIR/lock2" \
  EVAL_WORKFLOW_MAX_CONCURRENT="2" \
  EVAL_WORKFLOW_WORKDIR="$WORKDIR/isolated-regression" \
  MOCK_WRONG_FIXTURE="db-silent" \
  "$SCRIPT" 2>&1
)"
EXIT_CODE2=$?
set -e
assert_eq "$EXIT_CODE2" "1" "回帰時はexit 1"
assert_contains "$OUTPUT2" "NG: db-silent.md - expected=blocked actual=pass" "db-silent.mdの回帰を検出"

echo "--- ケース3: サーキットブレーカー(同時実行数上限でスキップ) ---"
LOCK_DIR3="$WORKDIR/lock3"
mkdir -p "$LOCK_DIR3"
# 生きているプロセス(= $$自身、テストスクリプト自体のPID)のロックエントリで上限(1)に到達させる
# (kill -0で死活判定するため、実在しないPIDのエントリはスクリプト側の掃除ロジックで消えてしまう)
mkdir -p "$LOCK_DIR3/$$"
set +e
OUTPUT3="$(
  EVAL_WORKFLOW_VERIFIER_CMD="$MOCK_VERIFIER" \
  EVAL_WORKFLOW_LOCK_DIR="$LOCK_DIR3" \
  EVAL_WORKFLOW_MAX_CONCURRENT="1" \
  EVAL_WORKFLOW_WORKDIR="$WORKDIR/isolated-cb" \
  "$SCRIPT" 2>&1
)"
EXIT_CODE3=$?
set -e
assert_eq "$EXIT_CODE3" "0" "サーキットブレーカー作動時はexit 0(fail-open)"
assert_contains "$OUTPUT3" "サーキットブレーカー" "サーキットブレーカーのメッセージが出る"
rmdir "$LOCK_DIR3/$$" 2>/dev/null || true

echo ""
if [ "$fail" -eq 0 ]; then
  echo "全テストOK"
  exit 0
else
  echo "テスト失敗あり"
  exit 1
fi
