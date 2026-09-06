#!/bin/bash
# WHY: scripts/lib/flaky-issue.sh の回帰テスト。gh をスタブに差し替え、open issue が無ければ create、
#      あれば comment になること、本文にレポートと再現コマンドが入ることを見る。
#
# 実行: bash scripts/lib/flaky-issue.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/flaky-issue.sh"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if printf '%s\n' "$1" | grep -qF -- "$2"; then assert_ok "$3"; else assert_fail "$3" "expected: $2"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# gh スタブ: 呼び出しを記録し、issue list は環境変数 STUB_OPEN_ISSUES の JSON を返す
cat > "$WORK/gh" <<'EOF'
#!/bin/bash
echo "$*" >> "$STUB_LOG"
case "$1 $2" in
  "issue list") printf '%s' "${STUB_OPEN_ISSUES:-[]}" ;;
  "issue create"|"issue comment")
    # --body-file の中身も記録する
    while [ $# -gt 0 ]; do
      if [ "$1" = "--body-file" ]; then cat "$2" >> "$STUB_LOG.body"; fi
      shift
    done
    ;;
esac
EOF
chmod +x "$WORK/gh"

printf '# フレーキー検知（3 回実行、10 テスト）\n\n## 揺れるテスト（flaky）: 1 件\n- `a.test.ts > t1` — passed 2 / failed 1\n' > "$WORK/report.md"

echo "=== scenario 1: open issue が無ければ create（label bug、本文にレポートと再現コマンド） ==="
export STUB_LOG="$WORK/log1"
: > "$STUB_LOG"
OUT="$(FLAKY_GH_BIN="$WORK/gh" STUB_OPEN_ISSUES='[]' SUITE=integration STATUS=1 bash "$TARGET" "$WORK/report.md" 2>&1)"
assert_contains "$OUT" "issue を作成: [flaky] integration" "create の経路"
assert_contains "$(cat "$STUB_LOG")" "issue create --title [flaky] integration --label bug" "gh issue create をタイトル・label 付きで呼ぶ"
assert_contains "$(cat "$STUB_LOG.body")" "## 揺れるテスト（flaky）: 1 件" "本文にレポートを含む"
assert_contains "$(cat "$STUB_LOG.body")" "--config vitest.integration.config.ts" "integration の再現コマンド"
assert_contains "$(cat "$STUB_LOG.body")" "揺れるテスト（flaky）: integration" "見出しに種別"

echo "=== scenario 2: 同じタイトルの open issue があれば comment で追記 ==="
export STUB_LOG="$WORK/log2"
: > "$STUB_LOG"
OUT="$(FLAKY_GH_BIN="$WORK/gh" STUB_OPEN_ISSUES='[{"number":42,"title":"[flaky] unit"},{"number":7,"title":"[flaky] unit-old"}]' SUITE=unit STATUS=2 bash "$TARGET" "$WORK/report.md" 2>&1)"
assert_contains "$OUT" "issue #42 に追記" "完全一致のタイトルだけを既存扱い"
assert_contains "$(cat "$STUB_LOG")" "issue comment 42 --body-file" "gh issue comment を呼ぶ"
assert_contains "$(cat "$STUB_LOG.body")" "毎回落ちるテスト（揺れではなくバグ）: unit" "STATUS=2 は常時失敗の見出し"
if grep -q "issue create" "$STUB_LOG"; then assert_fail "既存があるのに create した"; else assert_ok "create しない"; fi

echo "=== scenario 3: レポートが無ければ exit 1、SUITE / STATUS 未指定も exit 1 ==="
set +e
FLAKY_GH_BIN="$WORK/gh" SUITE=unit STATUS=1 bash "$TARGET" "$WORK/missing.md" >/dev/null 2>&1
s1=$?
FLAKY_GH_BIN="$WORK/gh" STATUS=1 bash "$TARGET" "$WORK/report.md" >/dev/null 2>&1
s2=$?
set -e
if [ "$s1" -ne 0 ]; then assert_ok "レポート不在で失敗"; else assert_fail "レポート不在なのに成功"; fi
if [ "$s2" -ne 0 ]; then assert_ok "SUITE 未指定で失敗"; else assert_fail "SUITE 未指定なのに成功"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
