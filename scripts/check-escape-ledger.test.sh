#!/usr/bin/env bash
set -uo pipefail

# WHY: 取りこぼしの輪は「落ちた検査を拾う → 見たか聞く → 片付ける」の 3 段で、
#      どれか 1 つが無音で死ぬと輪が開いたまま気づけない。
#      実際、拾う側は最初 `printf | python3 - <<'PY'` でヒアドキュメントが stdin を奪い、
#      **何も記録しないまま成功したように見えて**いた（2026-09-07 に実測して踏んだ）。
#      3 段それぞれについて、鳴ること・鳴らないことの両方を測る。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD="$SCRIPT_DIR/record-test-failure.sh"
CHECK="$SCRIPT_DIR/check-escape-ledger.sh"
TRIAGE="$SCRIPT_DIR/triage-escapes.sh"

fail=0
pass_count=0

ok() { echo "  OK: $1"; pass_count=$((pass_count + 1)); }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

contains() { if printf '%s' "$1" | grep -q "$2"; then ok "$3"; else ng "$3" "$1"; fi }
is_empty() {
  if [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; then ok "$2"; else ng "$2" "$1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
LEDGER="$WORK/ledger.md"
CANDIDATES="$WORK/escape-candidates.jsonl"

feed() { AIDD_LOG_DIR="$WORK" bash "$RECORD" > /dev/null 2>&1; }
ask() { AIDD_LOG_DIR="$WORK" ESCAPE_LEDGER="$LEDGER" bash "$CHECK" 2>&1; }

echo "=== scenario 1: 検査でないコマンドは拾わない ==="
printf '%s' '{"tool_input":{"command":"git status"},"tool_response":{"stdout":"FAILED"}}' > "$WORK/in.json"
feed < "$WORK/in.json"
if [ ! -f "$CANDIDATES" ]; then ok "無関係なコマンドは記録しない"; else ng "無関係なコマンドを記録した" "$(cat "$CANDIDATES")"; fi

echo "=== scenario 2: 通った検査は拾わない ==="
printf '%s' '{"tool_input":{"command":"npm test"},"tool_response":{"stdout":" Test Files  211 passed (211)\n Tests  1731 passed (1731)"}}' > "$WORK/in.json"
feed < "$WORK/in.json"
if [ ! -f "$CANDIDATES" ]; then ok "成功は記録しない（緑のたびに鳴らない）"; else ng "成功を記録した" "$(cat "$CANDIDATES")"; fi

echo "=== scenario 3: 落ちた検査を拾い、テスト名も残す ==="
printf '%s' '{"tool_input":{"command":"npm test"},"tool_response":{"stdout":" Tests  2 failed | 100 passed (102)\n     × 施設境界が守られる 3ms\n     × 監査行が 1 行だけ残る 1ms"}}' > "$WORK/in.json"
feed < "$WORK/in.json"
if [ -f "$CANDIDATES" ]; then ok "落ちた検査を記録する"; else ng "落ちた検査を記録できない"; fi
contains "$(cat "$CANDIDATES" 2>/dev/null)" "施設境界が守られる" "落ちたテスト名を残す"

echo "=== scenario 4: 終了コードが取れる版でも拾う ==="
rm -f "$CANDIDATES"
printf '%s' '{"tool_input":{"command":"bash scripts/foo.test.sh"},"tool_response":{"stdout":"ALL PASSED","exit_code":1}}' > "$WORK/in.json"
feed < "$WORK/in.json"
contains "$(cat "$CANDIDATES" 2>/dev/null)" '"exitCode": 1' "終了コードがあればそれを使う（本文が紛らわしくても）"

echo "=== scenario 5: 下書きがあり台帳を触っていないなら聞く ==="
OUT="$(ask)"
contains "$OUT" "取りこぼし台帳" "見たか聞く"

echo "=== scenario 6: 台帳を触れば黙る ==="
printf '# 台帳\n' > "$LEDGER"
OUT="$(ask)"
is_empty "$OUT" "台帳を触った後は鳴り止む"

echo "=== scenario 7: 台帳より新しい下書きが来たらまた聞く ==="
sleep 1
printf '%s' '{"tool_input":{"command":"npm test"},"tool_response":{"stdout":" Tests  1 failed | 1 passed (2)\n     × 別の失敗 1ms"}}' > "$WORK/in.json"
feed < "$WORK/in.json"
OUT="$(ask)"
contains "$OUT" "別の失敗" "新しい失敗は改めて聞く"

echo "=== scenario 8: 該当なしの記録でも黙るが、理由が要る ==="
if AIDD_LOG_DIR="$WORK" bash "$TRIAGE" --none "短" > /dev/null 2>&1; then
  ng "理由が短くても通してしまう"
else
  ok "理由が短いと拒否する"
fi
AIDD_LOG_DIR="$WORK" bash "$TRIAGE" --none "実装途中の RED であって取りこぼしではない" > /dev/null 2>&1
OUT="$(ask)"
is_empty "$OUT" "該当なしを記録すれば鳴り止む"

echo "=== scenario 9: 下書きが 1 件も無ければ何も言わない ==="
rm -f "$CANDIDATES"
OUT="$(ask)"
is_empty "$OUT" "何も起きていないときは無言"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
