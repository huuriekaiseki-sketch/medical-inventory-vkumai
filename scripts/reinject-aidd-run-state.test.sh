#!/bin/bash
# WHY: scripts/reinject-aidd-run-state.sh（SessionStart hook、matcher: compact、issue #712）の回帰テスト。
#      状態ファイルが無ければ沈黙し、あれば run-manifest / 進捗 / 復旧キューの要約を
#      additionalContext に出すこと、source が compact 以外なら何もしないことを確認する。
#      本物の .aidd/ や logs/ は環境変数で差し替え、書き換えない。
#
# 実行: bash scripts/reinject-aidd-run-state.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/reinject-aidd-run-state.sh"

fail=0
assert_empty() {
  if [ -z "$1" ]; then echo "  OK: $2"; else echo "  NG: $2 (actual=$1)"; fail=1; fi
}
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "  OK: $3"; else echo "  NG: $3"; echo "      expected: $2"; echo "      actual: $1"; fail=1; fi
}
assert_not_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then echo "  NG: $3 (unexpected: $2)"; fail=1; else echo "  OK: $3"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
EMPTY_MANIFEST="$WORK/no-manifest.json"
EMPTY_QUEUE="$WORK/no-queue.jsonl"
EMPTY_LOG="$WORK/no-log.jsonl"

run() {
  # $1=source $2=manifest $3=queue $4=log
  printf '{"session_id":"t","hook_event_name":"SessionStart","source":"%s"}' "$1" \
    | AIDD_MANIFEST_PATH="$2" RECOVERY_QUEUE_FILE="$3" AGENT_PROGRESS_LOG="$4" bash "$SCRIPT"
}

echo "=== scenario 1: 状態ファイルが何も無い → 何も出力しない ==="
OUT="$(run compact "$EMPTY_MANIFEST" "$EMPTY_QUEUE" "$EMPTY_LOG")"
assert_empty "$OUT" "状態が無ければ沈黙する"

echo "=== scenario 2: run-manifest がある → 要約を additionalContext に出す ==="
cat > "$WORK/run-manifest.json" <<'EOF'
{
  "specPath": "docs/superpowers/specs/2026-07-10-example-feature-design.md",
  "specHash": "3b1c9d5f2a6e4d0c8b7a1f9e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c",
  "baseCommit": "d1a7dbdb1c4e2f6a9b0c3d4e5f6a7b8c9d0e1f2a",
  "changedFiles": ["src/app/x.tsx", "src/lib/supabase/x.ts"],
  "approval": { "approvedBy": "reviewer@example.com", "approvedAt": "2026-07-10T05:00:00+09:00" }
}
EOF
OUT="$(run compact "$WORK/run-manifest.json" "$EMPTY_QUEUE" "$EMPTY_LOG")"
assert_contains "$OUT" '"hookEventName": "SessionStart"' "hookSpecificOutput が SessionStart"
assert_contains "$OUT" "additionalContext" "additionalContext を返す"
assert_contains "$OUT" "2026-07-10-example-feature-design.md" "specPath が入る"
assert_contains "$OUT" "specHash: 3b1c9d5f2a6e" "specHash は先頭 12 桁"
assert_contains "$OUT" "reviewer@example.com" "承認者が入る"
assert_contains "$OUT" "changedFiles: 2 件" "changedFiles 件数"
assert_contains "$OUT" "/goal" "/goal 条件へのポインタ"
assert_contains "$OUT" "CLAUDE.md" "CLAUDE.md 再注入へのポインタ"

echo "=== scenario 3: 承認前の manifest → 未承認と明示する ==="
jq 'del(.approval)' "$WORK/run-manifest.json" > "$WORK/run-manifest-unapproved.json"
OUT="$(run compact "$WORK/run-manifest-unapproved.json" "$EMPTY_QUEUE" "$EMPTY_LOG")"
assert_contains "$OUT" "未承認" "approval 欠如を未承認として出す"

echo "=== scenario 4: 復旧キューの未解決エントリ → 件数と id を出す。resolved は出さない ==="
cat > "$WORK/queue.jsonl" <<'EOF'
{"id":"r1","timestamp":"2026-09-01T00:00:00Z","type":"workflow-interrupted","detail":"x","status":"pending"}
{"id":"r2","timestamp":"2026-09-01T00:00:00Z","type":"gap-check-followup","detail":"y","status":"surfaced","surfacedAt":"2026-09-02T00:00:00Z"}
{"id":"r3","timestamp":"2026-09-01T00:00:00Z","type":"gap-check-followup","detail":"z","status":"resolved","resolvedAt":"2026-09-03T00:00:00Z"}
EOF
OUT="$(run compact "$EMPTY_MANIFEST" "$WORK/queue.jsonl" "$EMPTY_LOG")"
assert_contains "$OUT" "id=r1 status=pending" "pending を出す"
assert_contains "$OUT" "id=r2 status=surfaced" "surfaced を出す"
assert_not_contains "$OUT" "id=r3" "resolved は出さない"
assert_contains "$OUT" "resolve-recovery-task.sh" "解決手順へのポインタ"

echo "=== scenario 5: 進捗ログがある → show-agent-status.sh の出力を含める ==="
cat > "$WORK/progress.jsonl" <<'EOF'
{"timestamp":"2026-09-05T00:00:00Z","agent":"implementer-ui","feature":"example","status":"running","note":"UI実装中"}
EOF
OUT="$(run compact "$EMPTY_MANIFEST" "$EMPTY_QUEUE" "$WORK/progress.jsonl")"
assert_contains "$OUT" "implementer-ui" "エージェント名が入る"
assert_contains "$OUT" "サブエージェント進捗" "進捗セクションの見出し"

echo "=== scenario 6: source が compact 以外 → 状態があっても何も出力しない（二重注入防止） ==="
OUT="$(run startup "$WORK/run-manifest.json" "$WORK/queue.jsonl" "$WORK/progress.jsonl")"
assert_empty "$OUT" "startup では沈黙する"
OUT="$(run resume "$WORK/run-manifest.json" "$EMPTY_QUEUE" "$EMPTY_LOG")"
assert_empty "$OUT" "resume でも沈黙する"

echo "=== scenario 7: REINJECT_FORCE=1 なら source ガードを無効化できる（手動検証用） ==="
OUT="$(printf '{"source":"startup"}' | REINJECT_FORCE=1 AIDD_MANIFEST_PATH="$WORK/run-manifest.json" RECOVERY_QUEUE_FILE="$EMPTY_QUEUE" AGENT_PROGRESS_LOG="$EMPTY_LOG" bash "$SCRIPT")"
assert_contains "$OUT" "additionalContext" "FORCE で出力される"

echo "=== scenario 8: stdin が空でも壊れない（手動実行） ==="
OUT="$(AIDD_MANIFEST_PATH="$WORK/run-manifest.json" RECOVERY_QUEUE_FILE="$EMPTY_QUEUE" AGENT_PROGRESS_LOG="$EMPTY_LOG" bash "$SCRIPT" < /dev/null)"
assert_contains "$OUT" "additionalContext" "stdin 空でも出力される"

echo "=== scenario 9: 出力は妥当な JSON ==="
if printf '%s' "$OUT" | jq -e '.hookSpecificOutput.additionalContext | length > 0' >/dev/null; then
  echo "  OK: jq でパースできる"
else
  echo "  NG: JSON として不正"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
