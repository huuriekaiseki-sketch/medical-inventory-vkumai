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

contains() { if grep -q "$2" <<<"$1"; then ok "$3"; else ng "$3" "$1"; fi }
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
printf '%s' '{"tool_input":{"command":"bash scripts/example.test.sh"},"tool_response":{"stdout":" Test Files  211 passed (211)\n Tests  1731 passed (1731)"}}' > "$WORK/in.json"
feed < "$WORK/in.json"
if [ ! -f "$CANDIDATES" ]; then ok "成功は記録しない（緑のたびに鳴らない）"; else ng "成功を記録した" "$(cat "$CANDIDATES")"; fi

echo "=== scenario 3: 落ちた検査を拾い、テスト名も残す ==="
printf '%s' '{"tool_input":{"command":"bash scripts/example.test.sh"},"tool_response":{"stdout":" Tests  2 failed | 100 passed (102)\n     × 施設境界が守られる 3ms\n     × 監査行が 1 行だけ残る 1ms"}}' > "$WORK/in.json"
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
printf '%s' '{"tool_input":{"command":"bash scripts/example.test.sh"},"tool_response":{"stdout":" Tests  1 failed | 1 passed (2)\n     × 別の失敗 1ms"}}' > "$WORK/in.json"
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

# ここから先は、上の流れ（下書き → 聞く → 片付け）と混ざらないよう別の置き場で測る
WORK2="$WORK/b"
mkdir -p "$WORK2"
CANDIDATES2="$WORK2/escape-candidates.jsonl"
feed2() { AIDD_LOG_DIR="$WORK2" bash "$RECORD" > /dev/null 2>&1; }

# WHY(issue #875): Bash が 0 以外で終わると、Claude Code は PostToolUse ではなく PostToolUseFailure を
#      発火する（公式の hooks リファレンス）。この hook は PostToolUse にしか登録されておらず、
#      普通に落ちたテストは一度も下書きに載っていなかった（2026-09-07〜10-02 の 51 件は、すべて
#      exit 0 で終わったのに本文に失敗の文字があったもの。終了コードが取れた行は 0 件）。
#      失敗時の入力は形が違う（exit_code / stdout / stderr が tool_response の外にある、と公式は書く）ので、
#      どちらの置き場にあっても読めることを測る。
echo "=== scenario 10: PostToolUseFailure（失敗時のイベント）で届いた失敗を拾う ==="
printf '%s' '{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"bash scripts/foo.test.sh"},"tool_response":"Error: Exit code 1","error_type":"execution_error","exit_code":1,"stdout":"  NG: 施設をまたいで読めた\nFAILED","stderr":""}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ -f "$CANDIDATES2" ]; then ok "失敗時のイベントで届いた失敗を記録する"; else ng "失敗時のイベントで届いた失敗を記録できない"; fi
contains "$(cat "$CANDIDATES2" 2>/dev/null)" '"exitCode": 1' "外側にある終了コードを読む"
contains "$(cat "$CANDIDATES2" 2>/dev/null)" "施設をまたいで読めた" "外側にある stdout から落ちた名前を拾う"
contains "$(cat "$CANDIDATES2" 2>/dev/null)" '"event": "PostToolUseFailure"' "どのイベントで届いたかを残す（実機の形を後から確かめる）"

echo "=== scenario 11: 失敗時のイベントなら、本文が見知らぬ形でも拾う ==="
rm -f "$CANDIDATES2"
printf '%s' '{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"bash scripts/foo.test.sh"},"error":"Command failed with exit code 2"}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ -f "$CANDIDATES2" ]; then ok "終了コードも失敗の文字も無くても、イベントで失敗と分かれば記録する"; else ng "失敗時のイベントなのに記録しなかった（形を知らないと無音になる）"; fi
contains "$(cat "$CANDIDATES2" 2>/dev/null)" '"inputKeys"' "入力の鍵を残す（実機の形を後から確かめる）"

echo "=== scenario 12: 失敗時のイベントでも、検査でないコマンドは拾わない ==="
rm -f "$CANDIDATES2"
printf '%s' '{"hook_event_name":"PostToolUseFailure","tool_name":"Bash","tool_input":{"command":"git push"},"exit_code":1,"stderr":"rejected"}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ ! -f "$CANDIDATES2" ]; then ok "無関係なコマンドの失敗は記録しない"; else ng "無関係なコマンドの失敗を記録した" "$(cat "$CANDIDATES2")"; fi

# WHY(issue #875): aidd-core は言語を問わず配る。終了コードが取れない経路（exit 0 で本文に失敗が出る形）で
#      pytest / unittest の失敗の形を知らないと、Python の導入先では下書きに一度も載らない
#      （kojigyo-zei-rag への移植で見つかった）。
echo "=== scenario 13: pytest の失敗を拾い、ノード ID を名前に残す ==="
rm -f "$CANDIDATES2"
printf '%s' '{"tool_input":{"command":"python -m pytest tests"},"tool_response":{"stdout":"FAILED tests/test_tax.py::test_rounding - AssertionError: 1 != 2\n=================== 1 failed, 140 passed in 1.23s ===================="}}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ -f "$CANDIDATES2" ]; then ok "pytest の失敗を記録する"; else ng "pytest の失敗を記録できない"; fi
contains "$(cat "$CANDIDATES2" 2>/dev/null)" "tests/test_tax.py::test_rounding" "pytest のノード ID を名前に残す"

echo "=== scenario 14: unittest の失敗を拾う ==="
rm -f "$CANDIDATES2"
printf '%s' '{"tool_input":{"command":"python -m unittest discover"},"tool_response":{"stdout":"======================================================================\nFAIL: test_split (test_ledger.LedgerTest.test_split)\n----------------------------------------------------------------------\nFAILED (failures=1)"}}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ -f "$CANDIDATES2" ]; then ok "unittest の失敗を記録する"; else ng "unittest の失敗を記録できない"; fi
contains "$(cat "$CANDIDATES2" 2>/dev/null)" "test_split (test_ledger.LedgerTest.test_split)" "unittest のテスト名を残す"

echo "=== scenario 15: pytest の成功は拾わない（緑のたびに鳴らない） ==="
rm -f "$CANDIDATES2"
printf '%s' '{"tool_input":{"command":"python -m pytest tests"},"tool_response":{"stdout":"=================== 141 passed in 1.23s ===================="}}' > "$WORK/in.json"
feed2 < "$WORK/in.json"
if [ ! -f "$CANDIDATES2" ]; then ok "pytest の成功は記録しない"; else ng "pytest の成功を記録した" "$(cat "$CANDIDATES2")"; fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
