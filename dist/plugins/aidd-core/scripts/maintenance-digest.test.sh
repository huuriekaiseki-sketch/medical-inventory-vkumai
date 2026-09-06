#!/bin/bash
# WHY: scripts/maintenance-digest.sh（Setup hook、matcher maintenance。issue #741）の回帰テスト。
# 実物のランブック 3 本を書き換えず、環境変数で一時ファイルへ差し替えて決定的に検証する。
# あわせて .claude/settings.json に Setup(maintenance) の登録があることを検査する
# （settings 側の登録が落ちるとダイジェスト自体が呼ばれなくなるため）。
#
# 実行: bash scripts/maintenance-digest.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/maintenance-digest.sh"
SETTINGS="$SCRIPT_DIR/../.claude/settings.json"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
contains() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }
not_contains() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ng "$3" "unexpected: $2"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
iso_offset() { python3 -c "from datetime import date, timedelta; print((date.today() + timedelta(days=$1)).isoformat())"; }
write_doc() { printf '# x\n\n## 次回実施予定日\n\n%s（目安）\n' "$2" > "$1"; }

run_digest() {
  set +e
  OUT="$(FAULT_INJECTION_DRILL_DOC="$WORK/fi.md" HOOK_LIVE_DRILL_DOC="$WORK/hl.md" UPSTREAM_DOCS_REVIEW_DOC="$WORK/ud.md" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: 3 本とも期限前 → 超過なしのダイジェスト（次の期限一覧） ==="
write_doc "$WORK/fi.md" "$(iso_offset 30)"
write_doc "$WORK/hl.md" "$(iso_offset 60)"
write_doc "$WORK/ud.md" "$(iso_offset 10)"
run_digest
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "exit $EXIT_CODE"
contains "$OUT" "systemMessage" "Setup hook の JSON を返す"
contains "$OUT" '"hookEventName": "Setup"' "hookEventName が Setup"
contains "$OUT" "期限超過なし" "超過なしの要約"
contains "$OUT" "fault injection 訓練: 期限 $(iso_offset 30)" "各作業の次の期限を出す"
contains "$OUT" "あと 10 日" "残り日数を出す"

echo "=== scenario 2: 1 本が期限超過 → ⚠ と超過件数、手順への参照 ==="
write_doc "$WORK/hl.md" "$(iso_offset -5)"
run_digest
contains "$OUT" "hook 実走ドリル: ⚠ 期限 $(iso_offset -5) を 5 日超過" "超過した作業を ⚠ 付きで出す"
contains "$OUT" "期限超過 1 件" "超過件数を要約に出す"
contains "$OUT" "hook-live-drill.md" "手順への参照を出す"
not_contains "$OUT" "fault injection 訓練: ⚠" "期限前の作業には ⚠ を付けない"

echo "=== scenario 3: 日付が読めないランブック → その旨を出し、他の判定は続ける ==="
printf '# x\n\n本文のみ\n' > "$WORK/fi.md"
run_digest
contains "$OUT" "fault injection 訓練: 「## 次回実施予定日」から日付を読み取れません" "書式崩れを名指し"
contains "$OUT" "公式 docs 差分確認: 期限" "他の作業の判定は続く"

echo "=== scenario 4: ランブック不在 → その旨を出し、exit 0 ==="
rm -f "$WORK/ud.md"
run_digest
contains "$OUT" "公式 docs 差分確認: ランブックが見つかりません" "不在を名指し"
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0（block しない）" || ng "exit $EXIT_CODE"

echo "=== scenario 5: MAINTENANCE_DIGEST_PLAIN=1 → JSON でなく素のテキスト ==="
PLAIN="$(FAULT_INJECTION_DRILL_DOC="$WORK/fi.md" HOOK_LIVE_DRILL_DOC="$WORK/hl.md" UPSTREAM_DOCS_REVIEW_DOC="$WORK/ud.md" MAINTENANCE_DIGEST_PLAIN=1 bash "$SCRIPT" < /dev/null)"
not_contains "$PLAIN" "systemMessage" "素のテキストには JSON キーが無い"
contains "$PLAIN" "定期メンテナンスのダイジェスト" "見出し行がある"

echo "=== scenario 6: settings.json に Setup(maintenance) が登録されている ==="
if [ -f "$SETTINGS" ]; then
  REG="$(jq -r '.hooks.Setup[]? | select(.matcher == "maintenance") | .hooks[].command' "$SETTINGS")"
  contains "$REG" "scripts/maintenance-digest.sh" "Setup(maintenance) から maintenance-digest.sh が呼ばれる"
else
  ng "settings.json が見つからない"
fi

echo "=== scenario 7: 実態のランブック 3 本すべてから日付を読める（書式の回帰） ==="
REAL="$(MAINTENANCE_DIGEST_PLAIN=1 bash "$SCRIPT" < /dev/null)"
not_contains "$REAL" "読み取れません" "実態の 3 本は日付を読める"
not_contains "$REAL" "見つかりません" "実態の 3 本は存在する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
