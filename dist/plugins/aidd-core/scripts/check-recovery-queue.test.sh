#!/bin/bash
# WHY: scripts/check-recovery-queue.sh（issue #523のSessionStart hook）の回帰テスト。
# 実キューファイルに依存させず、一時ディレクトリのフェイクファイルで決定的に検証する。
#
# 実行: bash scripts/check-recovery-queue.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-recovery-queue.sh"

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
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
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

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

QUEUE_FILE="$WORK_DIR/recovery-queue.jsonl"

run_hook() {
  set +e
  OUT="$(RECOVERY_QUEUE_FILE="$QUEUE_FILE" bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: キューファイル無し → 沈黙 ==="
rm -f "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: pendingエントリが1件 → 警告し内容を含む ==="
jq -nc '{id: "a", timestamp: "2026-07-23T00:00:00Z", type: "gap-check-followup", detail: {gapWarnings: "x"}, status: "pending"}' > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "1件" "件数が含まれる"
assert_contains "$OUT" "gap-check-followup" "typeが含まれる"
assert_contains "$OUT" "issue #523" "issue番号が含まれる"

echo "=== scenario 3: 1回表示後はstatusがsurfacedに書き換わる ==="
STATUS="$(jq -r '.status' "$QUEUE_FILE")"
assert_eq "$STATUS" "surfaced" "statusがsurfacedになっている"

echo "=== scenario 4: surfaced済みエントリのみ → 2回目は沈黙 ==="
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "surfaced済みは再表示しない"

echo "=== scenario 5: pending・surfacedが混在 → pendingのみ対象になる ==="
{
  jq -nc '{id: "a", timestamp: "2026-07-23T00:00:00Z", type: "gap-check-followup", detail: {}, status: "surfaced"}'
  jq -nc '{id: "b", timestamp: "2026-07-23T00:01:00Z", type: "gap-check-followup", detail: {}, status: "pending"}'
} > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "1件" "pending1件のみが件数に数えられる"

echo "=== scenario 6: 壊れた行が混在 → クラッシュせず正当な行だけ処理する ==="
{
  printf '{broken json\n'
  jq -nc '{id: "c", timestamp: "2026-07-23T00:02:00Z", type: "gap-check-followup", detail: {}, status: "pending"}'
} > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（クラッシュしない）"
assert_contains "$OUT" "systemMessage" "壊れた行があっても正当な行は処理される"

echo "=== scenario 8: pending表示時にsurfacedAtが記録される ==="
jq -nc '{id: "d", timestamp: "2026-07-23T00:00:00Z", type: "gap-check-followup", detail: {}, status: "pending"}' > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
SURFACED_AT="$(jq -r '.surfacedAt' "$QUEUE_FILE")"
assert_eq "$([ -n "$SURFACED_AT" ] && [ "$SURFACED_AT" != "null" ] && echo yes || echo no)" "yes" "surfacedAtが記録される"

echo "=== scenario 9: 閾値超過のsurfaced放置エントリ → エスカレーション表示される ==="
jq -nc '{id: "e", timestamp: "2026-07-01T00:00:00Z", type: "gap-check-followup", detail: {}, status: "surfaced", surfacedAt: "2026-07-01T00:00:00Z"}' > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "issue #579" "issue #579への言及が含まれる"
assert_contains "$OUT" "resolve-recovery-task.sh" "解決方法への言及が含まれる"

echo "=== scenario 10: 閾値内のsurfacedエントリ → エスカレーションされない ==="
RECENT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
jq -nc --arg t "$RECENT" '{id: "f", timestamp: $t, type: "gap-check-followup", detail: {}, status: "surfaced", surfacedAt: $t}' > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "閾値内のsurfacedは沈黙する"

echo "=== scenario 11: resolved済みエントリ → エスカレーション対象外 ==="
jq -nc '{id: "g", timestamp: "2026-07-01T00:00:00Z", type: "gap-check-followup", detail: {}, status: "resolved", surfacedAt: "2026-07-01T00:00:00Z", resolvedAt: "2026-07-02T00:00:00Z"}' > "$QUEUE_FILE"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "resolved済みは対象外"

echo "=== scenario 7: jq不在 → 沈黙（fail-open） ==="
FAKE_BIN_DIR="$WORK_DIR/fake-bin-no-jq"
mkdir -p "$FAKE_BIN_DIR"
for bin in bash cat mktemp rm mv dirname; do
  real="$(command -v "$bin")"
  ln -sf "$real" "$FAKE_BIN_DIR/$bin"
done
jq -nc '{id: "a", timestamp: "2026-07-23T00:00:00Z", type: "x", detail: {}, status: "pending"}' > "$QUEUE_FILE"
set +e
OUT="$(PATH="$FAKE_BIN_DIR" RECOVERY_QUEUE_FILE="$QUEUE_FILE" bash "$SCRIPT" < /dev/null 2>&1)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "jq不在時は沈黙する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
