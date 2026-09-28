#!/bin/bash
# WHY: scripts/mark-supabase-started.sh（PreToolUse）の回帰テスト。
#   「supabase start を打つセッションのうち、起動前に動いていなかったときだけ印を残す」を固定する。
#   印は stop-supabase-on-session-end.sh が読む。印の誤記録（既に動いていたのに残す）は、
#   並行セッションのテストを終了時に巻き込む事故になるので、対を置いて確かめる。
#   supabase CLI は偽物（SUPABASE_BIN）で差し替え、実 Docker には触らない。
#
# 実行: bash scripts/mark-supabase-started.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_UNDER_TEST:-$SCRIPT_DIR/mark-supabase-started.sh}"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export SUPABASE_MARKER_DIR="$WORK/markers"
FAKE="$WORK/fake-supabase"
export SUPABASE_BIN="$FAKE"
CALLS="$WORK/calls.log"

# 偽の supabase: `status` は FAKE_RUNNING=1 のとき成功。呼び出しは記録する
cat > "$FAKE" <<'EOF'
#!/bin/bash
echo "$*" >> "${CALLS_FILE}"
case "$1" in
  status) [ "${FAKE_RUNNING:-0}" = "1" ] && exit 0 || exit 1 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE"
export CALLS_FILE="$CALLS"

run_hook() { # $1=command $2=session_id
  : > "$CALLS"
  set +e
  OUT="$(jq -n --arg c "$1" --arg s "$2" '{session_id: $s, tool_name: "Bash", tool_input: {command: $c}}' | bash "$SCRIPT")"
  RC=$?
  set -e
}

echo "=== scenario 1: 動いていない状態で supabase start → 印を残す ==="
FAKE_RUNNING=0 run_hook "supabase start" s1
[ "$RC" -eq 0 ] && ok "exit 0（ブロックしない）" || ng "exit $RC"
[ -z "$OUT" ] && ok "出力なし（permissionDecision を返さない）" || ng "何か出力した" "$OUT"
[ -f "$SUPABASE_MARKER_DIR/s1" ] && ok "印 s1 が残る" || ng "印が無い"
grep -q "^status" "$CALLS" && ok "起動前に status で確認している" || ng "status を呼んでいない"

echo "=== scenario 2: 既に動いている状態で supabase start → 印を残さない（対照） ==="
FAKE_RUNNING=1 run_hook "supabase start" s2
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit $RC"
[ ! -e "$SUPABASE_MARKER_DIR/s2" ] && ok "印 s2 は残らない（起動側ではない）" || ng "既に動いていたのに印を残した（並行セッションを巻き込む）"

echo "=== scenario 3: 引数付きの supabase start も対象 ==="
FAKE_RUNNING=0 run_hook "  supabase start --ignore-health-check" s3
[ -f "$SUPABASE_MARKER_DIR/s3" ] && ok "先頭空白と引数があっても印を残す" || ng "引数付きを見逃した"

echo "=== scenario 4: 無関係なコマンド → 何もしない ==="
for c in "supabase status" "supabase stop" "echo supabase start" "git grep 'supabase start'" "npm test"; do
  FAKE_RUNNING=0 run_hook "$c" s4
  if [ -e "$SUPABASE_MARKER_DIR/s4" ]; then ng "印を残した: $c"; rm -f "$SUPABASE_MARKER_DIR/s4"; else ok "沈黙: $c"; fi
  [ ! -s "$CALLS" ] && ok "status も呼ばない: $c" || ng "無関係なコマンドで status を呼んだ: $c"
done

echo "=== scenario 5: Bash 以外のツール・session_id 無し → 何もしない ==="
: > "$CALLS"
OUT="$(jq -n '{session_id: "s5", tool_name: "Edit", tool_input: {command: "supabase start"}}' | bash "$SCRIPT")"
[ ! -e "$SUPABASE_MARKER_DIR/s5" ] && ok "Edit では印を残さない" || ng "ツール名を見ていない"
OUT="$(jq -n '{tool_name: "Bash", tool_input: {command: "supabase start"}}' | bash "$SCRIPT")"
[ -z "$(ls -A "$SUPABASE_MARKER_DIR" 2>/dev/null | grep -v -E '^(s1|s3)$' || true)" ] && ok "session_id が無ければ印を残さない" || ng "session_id 無しで印を残した"

echo "=== scenario 6: jq 不在 → 静かに exit 0（止めない側に倒れる。ブロックはしない） ==="
EMPTY_BIN="$WORK/emptybin"
mkdir -p "$EMPTY_BIN"
set +e
OUT="$(printf '%s' '{"session_id":"s6","tool_name":"Bash","tool_input":{"command":"supabase start"}}' | PATH="$EMPTY_BIN" /bin/bash "$SCRIPT")"
RC=$?
set -e
[ "$RC" -eq 0 ] && ok "jq 不在でも exit 0" || ng "jq 不在で exit $RC"
[ ! -e "$SUPABASE_MARKER_DIR/s6" ] && ok "jq 不在では印を残さない" || ng "jq 無しで印を残した"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
