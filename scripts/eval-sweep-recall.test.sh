#!/bin/bash
# WHY: eval-sweep-recall.sh は claude -p のサブプロセス実行を含み実課金が発生するため、
# EVAL_SWEEP_RECALL_AGENT_CMD でモックに差し替えて判定ロジックを実課金なしで回帰テストする
# （eval-workflow-prompts.test.sh と同型）。issue #731 で、モデルが --json-schema を無視して素の
# テキストで返すと detail が空になり、欠陥を正しく報告していても MISS になる欠陥が見つかったため、
# その fallback（JSON でなければ生出力全体を判定対象にする）を RED/GREEN 両方向で固定する。
#
# 実行: bash scripts/eval-sweep-recall.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/eval-sweep-recall.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# --- clone 元となるダミー repo（buildSweepPrompt を含む） ---
DUMMY_REPO="$WORKDIR/dummy-repo"
mkdir -p "$DUMMY_REPO/.claude/workflows/lib/prompts" "$DUMMY_REPO/.claude/agents" "$DUMMY_REPO/docs/agents"
(
  cd "$DUMMY_REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "export function buildSweepPrompt(task, scope = 'full') { return 'task:' + task + ' scope:' + scope }" > .claude/workflows/lib/prompts/sweep.js
  printf -- '---\nname: sweep-x\ndescription: test\n---\nbody\n' > .claude/agents/sweep-x.md
  git add -A
  git commit -q -m "init"
)

# --- 最小 fixture セット ---
FIXTURES_DIR="$WORKDIR/fixtures"
mkdir -p "$FIXTURES_DIR/sweep-x/case-1/files/src/lib/probe"
echo '{ "agentType": "sweep-x", "model": "haiku" }' > "$FIXTURES_DIR/sweep-x/manifest.json"
echo "export const probe = 1" > "$FIXTURES_DIR/sweep-x/case-1/files/src/lib/probe/repository.ts"
echo '{ "expectedFilePathContains": "probe/repository.ts", "expectedKeywords": ["internalNote", "型不一致"] }' > "$FIXTURES_DIR/sweep-x/case-1/expected.json"

MOCK_AGENT="$WORKDIR/mock-agent.sh"
MOCK_RESPONSE_FILE="$WORKDIR/mock-response.txt"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }

run_eval() {
  set +e
  OUT="$(
    EVAL_SWEEP_RECALL_REPO_DIR="$DUMMY_REPO" \
    EVAL_SWEEP_RECALL_FIXTURES_DIR="$FIXTURES_DIR" \
    EVAL_SWEEP_RECALL_LOCK_DIR="$WORKDIR/lock" \
    EVAL_SWEEP_RECALL_AGENT_CMD="MOCK_RESPONSE_FILE='$MOCK_RESPONSE_FILE' '$MOCK_AGENT'" \
    bash "$SCRIPT" sweep-x 2>&1
  )"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: JSON 応答の detail に期待パスとキーワード → HIT ==="
printf '{"status":"pass","detail":"src/lib/probe/repository.ts:5 — internalNote が型定義に無い"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "JSON 応答で HIT"
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "exit $EXIT_CODE"

echo "=== scenario 2: 素のテキスト応答（--json-schema 無視）でも本文に期待パスとキーワードがあれば HIT（issue #731） ==="
# WHY: 2026-09-05 実測。haiku が Markdown の素テキストで返し、jq が失敗して detail 空 → MISS になっていた
printf '## 調査結果\n\n3. **EvalFixtureRecallItem** - src/lib/probe/repository.ts\n   - mapper が internalNote を追加返却\n' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "素テキスト応答で HIT（生出力 fallback）"
assert_contains "$OUT" "JSON ではないため生出力全体を判定対象" "fallback したことを標準エラーに出す"

echo "=== scenario 3: 素のテキスト応答で期待パスが無ければ MISS（fallback が過検出を生まない） ==="
printf '## 調査結果\n\n指摘なし。internalNote について特記事項なし\n' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 0 / 1" "パス無しは MISS のまま"
[ "$EXIT_CODE" -eq 1 ] && ok "MISS で exit 1" || ng "MISS なのに exit $EXIT_CODE"

echo "=== scenario 4: expectedFilePathContains が配列なら、いずれか 1 つのパスで HIT（層をまたぐ欠陥、issue #731） ==="
# WHY: 型定義と mapper の不一致のように 2 ファイルにまたがる欠陥は、エージェントがどちら側を指しても正しい検出
echo '{ "expectedFilePathContains": ["probe/repository.ts", "types/probe.ts"], "expectedKeywords": ["internalNote"] }' > "$FIXTURES_DIR/sweep-x/case-1/expected.json"
printf '{"status":"pass","detail":"src/types/probe.ts — internalNote が型定義に無い（repository が返している）"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "配列の 2 つ目のパスで HIT"
printf '{"status":"pass","detail":"src/lib/other.ts — internalNote について"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 0 / 1" "配列のどれにも一致しなければ MISS"

echo "=== scenario 5: 実行痕跡が REPO_DIR の docs/agents/eval-runs.jsonl に追記される ==="
RUNS="$(cat "$DUMMY_REPO/docs/agents/eval-runs.jsonl")"
assert_contains "$RUNS" '"fixtureSet":"sweep-x"' "fixtureSet を記録"
LINES="$(wc -l < "$DUMMY_REPO/docs/agents/eval-runs.jsonl" | tr -d ' ')"
[ "$LINES" -eq 5 ] && ok "5 回の実行で 5 行" || ng "行数が $LINES（期待 5）"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
