#!/bin/bash
# WHY: issue #18（サブエージェントの進捗・生死可視化）向けのlog-agent-progress.sh /
# show-agent-status.shはbash+jqのみで完結し、vitestの対象外のため、ここで回帰テストとして固定する。
#
# 実行: bash scripts/show-agent-status.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_AGENT_PROGRESS="$SCRIPT_DIR/log-agent-progress.sh"
SHOW_AGENT_STATUS="$SCRIPT_DIR/show-agent-status.sh"

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT
cd "$WORKDIR"
LOG_FILE="$WORKDIR/agent-progress.jsonl"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual output: $haystack"
    fail=1
  fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    echo "  NG: $label (should NOT contain: $needle)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

# --- fixture: テスト実行時刻を基準epochとして採用し、jqでISO8601に変換して組み立てる ---
# WHY: 固定の未来日時をハードコードすると実行環境の実時刻とズレて経過秒数の期待値が崩れるため、
# 実行時点のUNIX epochを基準に相対時刻で組み立てる（date -d はGNU/BSDで挙動が違うためjqのgmtimeを使う）。
BASE_EPOCH="$(date -u +%s)"
epoch_to_iso() {
  jq -n --argjson e "$1" '$e | gmtime | strftime("%Y-%m-%dT%H:%M:%SZ")' | tr -d '"'
}

bash "$LOG_AGENT_PROGRESS" --agent "sweep-db" --feature "f1" --status done --note "スイーパー完了" --log-file "$LOG_FILE"
bash "$LOG_AGENT_PROGRESS" --agent "implementer-a" --feature "f1" --status running --note "lib実装中..." --log-file "$LOG_FILE"
bash "$LOG_AGENT_PROGRESS" --agent "proposer-mvp" --feature "f1" --status waiting --note "待機中" --log-file "$LOG_FILE"
bash "$LOG_AGENT_PROGRESS" --agent "reviewer-x" --feature "f1" --status failed --note "型エラーで中断" --log-file "$LOG_FILE"

# 3分(180秒)を超えて更新がない running のエージェント（stale扱いになるべき）
printf '{"timestamp":"%s","agent":"sweep-ui","feature":"f1","status":"running","note":"UI調査中..."}\n' "$(epoch_to_iso $((BASE_EPOCH - 300)))" >> "$LOG_FILE"
# 2分(120秒)しか経っていない running のエージェント（stale扱いにならないべき）
printf '{"timestamp":"%s","agent":"sweep-types","feature":"f1","status":"running","note":"型調査中..."}\n' "$(epoch_to_iso $((BASE_EPOCH - 120)))" >> "$LOG_FILE"
# 同じagent名で複数回報告された場合、最新の1件だけが採用されるべき
bash "$LOG_AGENT_PROGRESS" --agent "sweep-db" --feature "f1" --status running --note "古い状態(上書きされるべき)" --log-file "$LOG_FILE"
sleep 1.1
bash "$LOG_AGENT_PROGRESS" --agent "sweep-db" --feature "f1" --status done --note "最新の完了報告" --log-file "$LOG_FILE"

OUTPUT="$(bash "$SHOW_AGENT_STATUS" --log-file "$LOG_FILE" --now-epoch "$BASE_EPOCH")"

echo "=== test: doneは✓付きでnoteがそのまま表示される ==="
assert_contains "$OUTPUT" "sweep-db：最新の完了報告 ✓" "sweep-dbは最新のdone報告(✓)が表示される"

echo "=== test: 同じagent名の古い報告は表示に含まれない ==="
assert_not_contains "$OUTPUT" "古い状態(上書きされるべき)" "同一agentの古い報告は消える"

echo "=== test: runningはnoteがそのまま表示される ==="
assert_contains "$OUTPUT" "implementer-a：lib実装中..." "implementer-aの進捗メモが表示される"

echo "=== test: waitingはnoteがそのまま表示される ==="
assert_contains "$OUTPUT" "proposer-mvp：待機中" "proposer-mvpの待機中が表示される"

echo "=== test: failedは✗付きで表示される ==="
assert_contains "$OUTPUT" "reviewer-x：型エラーで中断 ✗" "reviewer-xの失敗(✗)が表示される"

echo "=== test: stale-seconds(既定180秒)を超えたrunningは「止まってる？」になる ==="
assert_contains "$OUTPUT" "sweep-ui：止まってる？（300秒応答なし）" "sweep-uiは5分応答なしで止まってる扱いになる"

echo "=== test: stale-seconds未満のrunningは「止まってる？」にならない ==="
assert_not_contains "$OUTPUT" "sweep-types：止まってる？" "sweep-typesは2分経過のみなので止まってる扱いにならない"
assert_contains "$OUTPUT" "sweep-types：型調査中..." "sweep-typesは通常の進捗表示のまま"

echo "=== test: ログファイルが存在しない場合はエラーにならず案内文を返す ==="
NO_LOG_OUTPUT="$(bash "$SHOW_AGENT_STATUS" --log-file "$WORKDIR/no-such-file.jsonl")"
assert_contains "$NO_LOG_OUTPUT" "進捗ログがありません" "ログ未生成時は案内文を返す"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
