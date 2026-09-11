#!/bin/bash
# WHY: scripts/check-dependency-update-staleness.sh（SessionStart hook、issue #757 の 21）の回帰テスト。
# 実物の docs/agents/dependency-update-runbook.md を書き換えず、DEPENDENCY_UPDATE_DOC で一時ファイルへ
# 差し替えて決定的に検証する（check-upstream-docs-review-staleness.test.sh と同型）。
#
# 実行: bash scripts/check-dependency-update-staleness.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-dependency-update-staleness.sh"
SETTINGS="$SCRIPT_DIR/../.claude/settings.json"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
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

iso_offset() {
  python3 -c "
from datetime import date, timedelta
print((date.today() + timedelta(days=$1)).isoformat())
"
}

echo "=== scenario 1: 次回実施予定日が未来 → 何も出力しない ==="
printf '## 次回実施予定日\n\n%s（月 1 の目安）\n' "$(iso_offset 30)" > "$TMPDIR_TEST/future.md"
OUT="$(DEPENDENCY_UPDATE_DOC="$TMPDIR_TEST/future.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: 次回実施予定日が過去(期限切れ) → 警告する ==="
PAST="$(iso_offset -10)"
printf '## 次回実施予定日\n\n%s（月 1 の目安）\n' "$PAST" > "$TMPDIR_TEST/past.md"
OUT="$(DEPENDENCY_UPDATE_DOC="$TMPDIR_TEST/past.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "$PAST" "期限日が含まれる"
assert_contains "$OUT" "10日過ぎています" "超過日数が含まれる"
assert_contains "$OUT" "npm outdated" "手順（npm outdated と Dependabot PR）への導線がある"
assert_contains "$OUT" "additionalContext" "additionalContextフィールドがある"

echo "=== scenario 3: 次回実施予定日が今日ちょうど → 警告する(期限当日も対象) ==="
printf '## 次回実施予定日\n\n%s\n' "$(iso_offset 0)" > "$TMPDIR_TEST/today.md"
OUT="$(DEPENDENCY_UPDATE_DOC="$TMPDIR_TEST/today.md" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "当日も警告対象になる"

echo "=== scenario 4: 見出し自体が無い/日付を抽出できない → 警告する(書式崩れの検知) ==="
printf '## 別の見出し\n\n本文のみで日付が無い\n' > "$TMPDIR_TEST/broken.md"
OUT="$(DEPENDENCY_UPDATE_DOC="$TMPDIR_TEST/broken.md" bash "$SCRIPT")"
assert_contains "$OUT" "読み取れませんでした" "書式崩れの警告が出る"

echo "=== scenario 5: ドキュメント自体が存在しない → 何も出力しない ==="
OUT="$(DEPENDENCY_UPDATE_DOC="$TMPDIR_TEST/no-such-file.md" bash "$SCRIPT")"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 6: 実態の docs/agents/dependency-update-runbook.md から日付を読める（書式の回帰） ==="
OUT="$(cd "$SCRIPT_DIR/.." && bash "$SCRIPT")"
if grep -qF "読み取れませんでした" <<<"$OUT"; then
  echo "  NG: 実態のファイルの「## 次回実施予定日」から日付を読み取れない"; fail=1
else
  echo "  OK: 実態のファイルの書式は読み取れる（期限前なら沈黙、期限後なら超過警告）"
fi

echo "=== scenario 7: settings.json の SessionStart に登録されている（登録が落ちると無音で止まる） ==="
if [ -f "$SETTINGS" ]; then
  REG="$(jq -r '.hooks.SessionStart[].hooks[].command' "$SETTINGS")"
  assert_contains "$REG" "scripts/check-dependency-update-staleness.sh" "SessionStart から呼ばれる"
else
  echo "  NG: settings.json が見つからない"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
