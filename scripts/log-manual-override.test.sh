#!/bin/bash
# WHY: scripts/log-manual-override.sh（issue #757 の 33）の回帰テスト。必須引数・ID 規約・JSONL の形を固定する。
#
# 実行: bash scripts/log-manual-override.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/log-manual-override.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
LOG="$WORK/manual-overrides.jsonl"

echo "=== scenario 1: 必須引数が揃えば 1 行追記される（JSON、必要なキー） ==="
OUT="$(bash "$SCRIPT" --safeguard H-009 --actor tester --reason "本番の価格を手修正" --ref "issue #1" --log-file "$LOG")"
if grep -q "記録しました" <<<"$OUT"; then ok "記録した旨を出す"; else ng "出力が違う" "$OUT"; fi
if [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 1 ]; then ok "1 行追記"; else ng "行数が違う"; fi
for key in timestamp safeguard actor reason ref branch; do
  if jq -e "has(\"$key\")" "$LOG" >/dev/null; then ok "キー $key"; else ng "キー $key が無い"; fi
done
if [ "$(jq -r '.safeguard' "$LOG")" = "H-009" ]; then ok "safeguard の値"; else ng "safeguard の値が違う"; fi

echo "=== scenario 2: 2 回目は追記（上書きしない） ==="
bash "$SCRIPT" --safeguard H-001 --actor tester --reason "赤 check のままマージ" --log-file "$LOG" >/dev/null
if [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 2 ]; then ok "2 行になる"; else ng "追記されていない"; fi

echo "=== scenario 3: 必須引数が欠けると exit 1（記録しない） ==="
set +e
bash "$SCRIPT" --safeguard H-001 --actor tester --log-file "$LOG" >/dev/null 2>&1
s1=$?
bash "$SCRIPT" --safeguard bogus --actor tester --reason x --log-file "$LOG" >/dev/null 2>&1
s2=$?
set -e
if [ "$s1" -ne 0 ]; then ok "--reason 無しは失敗"; else ng "--reason 無しで成功"; fi
if [ "$s2" -ne 0 ]; then ok "H-3桁でない safeguard は失敗"; else ng "不正な safeguard で成功"; fi
if [ "$(wc -l < "$LOG" | tr -d ' ')" -eq 2 ]; then ok "失敗時は追記しない"; else ng "失敗時に追記した"; fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
