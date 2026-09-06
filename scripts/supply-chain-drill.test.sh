#!/usr/bin/env bash
# WHY: supply-chain-drill.sh（供給網の侵害演習、issue #757 の 30）の回帰テスト。
#   (a) 全シナリオが実行でき、集計行を出す
#   (b) 検知系 4 シナリオが「検知した」と報告する（検知器が退行したらここが落ちる）
#   (c) 演習はリポジトリの追跡ファイルを変更しない（改ざんは一時ディレクトリに閉じる）
#   (d) ランブックの実施記録に全シナリオ名が載っている（シナリオを足して記録を忘れない）
#
# 実行: bash scripts/supply-chain-drill.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNBOOK="$REPO_ROOT/docs/agents/supply-chain-drill.md"
SCENARIOS="plugin-swap plugin-inject plugin-partial lockfile-swap action-tag"

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

echo "=== scenario 1: 演習が最後まで走り、集計を出す ==="
BEFORE="$(cd "$REPO_ROOT" && git status --porcelain)"
OUT="$(bash "$SCRIPT_DIR/supply-chain-drill.sh" 2>&1)"
RC=$?
if [ "$RC" -eq 0 ]; then assert_ok "終了コード 0"; else assert_fail "終了コードが 0 でない: $RC" "$OUT"; fi
if printf '%s' "$OUT" | grep -q -- '--- 検知 '; then assert_ok "集計行がある"; else assert_fail "集計行が無い" "$OUT"; fi

echo "=== scenario 2: 検知系のシナリオが検知する ==="
for s in plugin-swap plugin-inject plugin-partial lockfile-swap; do
  if printf '%s\n' "$OUT" | grep -q "✅ $s:"; then
    assert_ok "$s を検知"
  else
    assert_fail "$s を検知できない（検知器の退行を疑う）" "$(printf '%s\n' "$OUT" | grep "$s")"
  fi
done

echo "=== scenario 3: リポジトリの追跡ファイルを変更しない ==="
AFTER="$(cd "$REPO_ROOT" && git status --porcelain)"
if [ "$BEFORE" = "$AFTER" ]; then
  assert_ok "git status が演習の前後で同じ"
else
  assert_fail "演習がリポジトリを変更した（改ざんは一時ディレクトリに閉じること）" "$(diff <(printf '%s' "$BEFORE") <(printf '%s' "$AFTER"))"
fi

echo "=== scenario 4: ランブックの実施記録に全シナリオが載っている ==="
for s in $SCENARIOS; do
  if grep -q "\`$s\`" "$RUNBOOK"; then
    assert_ok "記録あり: $s"
  else
    assert_fail "ランブックに $s の行が無い（シナリオを足したら実施記録にも足す）"
  fi
done

echo "=== scenario 5: 未知のシナリオ名は黙って通さない ==="
OUT2="$(bash "$SCRIPT_DIR/supply-chain-drill.sh" no-such-scenario 2>&1)"
if printf '%s' "$OUT2" | grep -q '不明なシナリオ'; then
  assert_ok "未知のシナリオを報告する"
else
  assert_fail "未知のシナリオが黙って通った" "$OUT2"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
