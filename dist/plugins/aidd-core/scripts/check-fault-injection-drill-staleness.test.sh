#!/bin/bash
# WHY: scripts/check-fault-injection-drill-staleness.sh(SessionStart hook)の回帰テスト。
# 実物のdocs/agents/fault-injection-drill.mdを書き換えず、テスト用の一時ファイルを
# FAULT_INJECTION_DRILL_DOC環境変数で差し替えて決定的に検証する。
#
# 実行: bash scripts/check-fault-injection-drill-staleness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-fault-injection-drill-staleness.sh"

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
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
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

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT

future_iso() {
  python3 -c "
from datetime import date, timedelta
print((date.today() + timedelta(days=$1)).isoformat())
"
}
past_iso() {
  python3 -c "
from datetime import date, timedelta
print((date.today() - timedelta(days=$1)).isoformat())
"
}

echo "=== scenario 1: 次回実施予定日が未来 → 何も出力しない ==="
FUTURE="$(future_iso 30)"
cat > "$TMPDIR_TEST/drill-future.md" <<EOF
## 次回実施予定日

$FUTURE（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-future.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: 次回実施予定日が過去(期限切れ) → 警告する ==="
PAST="$(past_iso 10)"
cat > "$TMPDIR_TEST/drill-past.md" <<EOF
## 次回実施予定日

$PAST（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-past.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "$PAST" "期限日が含まれる"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 3: 次回実施予定日が今日ちょうど → 警告する(期限当日も対象) ==="
TODAY="$(past_iso 0)"
cat > "$TMPDIR_TEST/drill-today.md" <<EOF
## 次回実施予定日

$TODAY（四半期後の目安。手動で書き換える。リマインド機構は無い）
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-today.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "当日も警告対象になる"

echo "=== scenario 4: 見出し自体が無い/日付を抽出できない → 警告する(書式崩れの検知) ==="
cat > "$TMPDIR_TEST/drill-broken.md" <<EOF
## 別の見出し

本文のみで日付が無い
EOF
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/drill-broken.md" bash "$SCRIPT")"
assert_contains "$OUT" "読み取れませんでした" "書式崩れの警告が出る"

echo "=== scenario 5: ドキュメント自体が存在しない → 何も出力しない ==="
OUT="$(FAULT_INJECTION_DRILL_DOC="$TMPDIR_TEST/no-such-file.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
