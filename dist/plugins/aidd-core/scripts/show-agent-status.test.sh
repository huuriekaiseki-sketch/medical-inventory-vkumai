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

echo "=== test: max-age-seconds(既定7日)より古い最終報告は表示せず、非表示件数を末尾に出す ==="
# WHY: 追記のみのログに残った数週間前の running が「止まってる？（数百万秒応答なし）」として
#      再注入（issue #712）のたびに混ざっていた。過去フローの残骸は既定で落とす。
OLD_LOG="$WORKDIR/agent-progress-old.jsonl"
printf '{"timestamp":"%s","agent":"implementer-old","feature":"f0","status":"running","note":"40日前の残骸"}\n' "$(epoch_to_iso $((BASE_EPOCH - 3456000)))" >> "$OLD_LOG"
printf '{"timestamp":"%s","agent":"reviewer-old","feature":"f0","status":"done","note":"40日前の完了"}\n' "$(epoch_to_iso $((BASE_EPOCH - 3456000)))" >> "$OLD_LOG"
printf '{"timestamp":"%s","agent":"sweep-6days","feature":"f1","status":"done","note":"6日前の完了"}\n' "$(epoch_to_iso $((BASE_EPOCH - 518400)))" >> "$OLD_LOG"
printf '{"timestamp":"%s","agent":"sweep-now","feature":"f1","status":"running","note":"進行中"}\n' "$(epoch_to_iso $((BASE_EPOCH - 60)))" >> "$OLD_LOG"
OLD_OUTPUT="$(bash "$SHOW_AGENT_STATUS" --log-file "$OLD_LOG" --now-epoch "$BASE_EPOCH")"
assert_not_contains "$OLD_OUTPUT" "implementer-old" "40日前のrunningは表示しない（止まってる？にもならない）"
assert_not_contains "$OLD_OUTPUT" "reviewer-old" "40日前のdoneも表示しない"
assert_contains "$OLD_OUTPUT" "sweep-6days：6日前の完了 ✓" "7日未満のdoneは表示する"
assert_contains "$OLD_OUTPUT" "sweep-now：進行中" "現在進行中は表示する"
assert_contains "$OLD_OUTPUT" "（他 2 件は最終報告が 604800 秒（7 日）より前のため非表示" "非表示件数を末尾に出す"

echo "=== test: --max-age-seconds 0 なら全件表示する（従来挙動） ==="
ALL_OUTPUT="$(bash "$SHOW_AGENT_STATUS" --log-file "$OLD_LOG" --now-epoch "$BASE_EPOCH" --max-age-seconds 0)"
assert_contains "$ALL_OUTPUT" "implementer-old：止まってる？（3456000秒応答なし）" "0指定で古いrunningも止まってる？として出る"
assert_not_contains "$ALL_OUTPUT" "非表示" "0指定では非表示の案内を出さない"

echo "=== test: 非表示が0件なら末尾の案内を出さない ==="
assert_not_contains "$OUTPUT" "非表示" "全件が新しい場合は案内なし"

echo "=== test: ログファイルが存在しない場合はエラーにならず案内文を返す ==="
NO_LOG_OUTPUT="$(bash "$SHOW_AGENT_STATUS" --log-file "$WORKDIR/no-such-file.jsonl")"
assert_contains "$NO_LOG_OUTPUT" "進捗ログがありません" "ログ未生成時は案内文を返す"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
