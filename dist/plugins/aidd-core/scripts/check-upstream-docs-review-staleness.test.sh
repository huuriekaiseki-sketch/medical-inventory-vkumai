#!/bin/bash
# WHY: scripts/check-upstream-docs-review-staleness.sh(SessionStart hook)の回帰テスト。
# 実物のdocs/agents/upstream-docs-review.mdを書き換えず、テスト用の一時ファイルを
# UPSTREAM_DOCS_REVIEW_DOC環境変数で差し替えて決定的に検証する
# （check-fault-injection-drill-staleness.test.shと同型）。
#
# 実行: bash scripts/check-upstream-docs-review-staleness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-upstream-docs-review-staleness.sh"

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
printf '## 次回実施予定日\n\n%s（月 1 の目安）\n' "$FUTURE" > "$TMPDIR_TEST/future.md"
OUT="$(UPSTREAM_DOCS_REVIEW_DOC="$TMPDIR_TEST/future.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: 次回実施予定日が過去(期限切れ) → 警告する ==="
PAST="$(past_iso 10)"
printf '## 次回実施予定日\n\n%s（月 1 の目安）\n' "$PAST" > "$TMPDIR_TEST/past.md"
OUT="$(UPSTREAM_DOCS_REVIEW_DOC="$TMPDIR_TEST/past.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "$PAST" "期限日が含まれる"
assert_contains "$OUT" "10日過ぎています" "超過日数が含まれる"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 3: 次回実施予定日が今日ちょうど → 警告する(期限当日も対象) ==="
TODAY="$(past_iso 0)"
printf '## 次回実施予定日\n\n%s\n' "$TODAY" > "$TMPDIR_TEST/today.md"
OUT="$(UPSTREAM_DOCS_REVIEW_DOC="$TMPDIR_TEST/today.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "当日も警告対象になる"

echo "=== scenario 4: 見出し自体が無い/日付を抽出できない → 警告する(書式崩れの検知) ==="
printf '## 別の見出し\n\n本文のみで日付が無い\n' > "$TMPDIR_TEST/broken.md"
OUT="$(UPSTREAM_DOCS_REVIEW_DOC="$TMPDIR_TEST/broken.md" bash "$SCRIPT")"
assert_contains "$OUT" "読み取れませんでした" "書式崩れの警告が出る"

echo "=== scenario 5: ドキュメント自体が存在しない → 何も出力しない ==="
OUT="$(UPSTREAM_DOCS_REVIEW_DOC="$TMPDIR_TEST/no-such-file.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: 実態の docs/agents/upstream-docs-review.md から日付を読める（書式の回帰） ==="
OUT="$(bash "$SCRIPT")"
if printf '%s' "$OUT" | grep -qF "読み取れませんでした"; then
  echo "  NG: 実態のファイルの「## 次回実施予定日」から日付を読み取れない"; fail=1
else
  echo "  OK: 実態のファイルの書式は読み取れる（期限前なら沈黙、期限後なら超過警告）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
