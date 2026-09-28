#!/bin/bash
# WHY: scripts/stop-supabase-on-session-end.sh（SessionEnd）の回帰テスト。
#   「印があるセッションの終了時だけ supabase stop を呼び、印を消す」を固定する。
#   印が無いのに止める（別セッションのテストを巻き込む）、印があるのに止めない（止め忘れ）の両方向を見る。
#   supabase CLI は偽物（SUPABASE_BIN）で差し替え、実 Docker には触らない。
#
# 実行: bash scripts/stop-supabase-on-session-end.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_UNDER_TEST:-$SCRIPT_DIR/stop-supabase-on-session-end.sh}"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export SUPABASE_MARKER_DIR="$WORK/markers"
mkdir -p "$SUPABASE_MARKER_DIR"
FAKE="$WORK/fake-supabase"
export SUPABASE_BIN="$FAKE"
CALLS="$WORK/calls.log"
export CALLS_FILE="$CALLS"

cat > "$FAKE" <<'EOF'
#!/bin/bash
echo "$*" >> "${CALLS_FILE}"
case "$1" in
  status) [ "${FAKE_RUNNING:-0}" = "1" ] && exit 0 || exit 1 ;;
  stop) exit "${FAKE_STOP_RC:-0}" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$FAKE"

run_hook() { # $1=session_id
  : > "$CALLS"
  set +e
  OUT="$(jq -n --arg s "$1" '{session_id: $s, hook_event_name: "SessionEnd", reason: "other"}' | bash "$SCRIPT")"
  RC=$?
  set -e
}

echo "=== scenario 1: 印あり・動いている → stop を呼び、印を消す ==="
touch "$SUPABASE_MARKER_DIR/s1"
FAKE_RUNNING=1 run_hook s1
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit $RC"
grep -q "^stop" "$CALLS" && ok "supabase stop を呼んだ" || ng "stop を呼んでいない（止め忘れ）" "$(cat "$CALLS")"
[ ! -e "$SUPABASE_MARKER_DIR/s1" ] && ok "印を消した" || ng "印が残っている"

echo "=== scenario 2: 印なし → 何もしない（別セッションのテストを巻き込まない。対照） ==="
FAKE_RUNNING=1 run_hook s2
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit $RC"
[ ! -s "$CALLS" ] && ok "status も stop も呼ばない" || ng "印が無いのに supabase を触った" "$(cat "$CALLS")"

echo "=== scenario 3: 印あり・既に止まっている → stop は呼ばず、印だけ消す ==="
touch "$SUPABASE_MARKER_DIR/s3"
FAKE_RUNNING=0 run_hook s3
grep -q "^stop" "$CALLS" && ng "止まっているのに stop を呼んだ" || ok "止まっていれば stop を呼ばない"
[ ! -e "$SUPABASE_MARKER_DIR/s3" ] && ok "印を消した" || ng "印が残っている"

echo "=== scenario 4: stop が失敗しても exit 0 で印は消す（セッション終了を妨げない） ==="
touch "$SUPABASE_MARKER_DIR/s4"
FAKE_RUNNING=1 FAKE_STOP_RC=1 run_hook s4
[ "$RC" -eq 0 ] && ok "stop 失敗でも exit 0" || ng "exit $RC"
[ ! -e "$SUPABASE_MARKER_DIR/s4" ] && ok "印は消す（次回の起動側判定を狂わせない）" || ng "印が残っている"

echo "=== scenario 5: 別セッションの印には触らない ==="
touch "$SUPABASE_MARKER_DIR/other"
FAKE_RUNNING=1 run_hook s5
[ -e "$SUPABASE_MARKER_DIR/other" ] && ok "他セッションの印は残る" || ng "他セッションの印を消した"
[ ! -s "$CALLS" ] && ok "他セッションの印では止めない" || ng "他セッションの印で supabase を触った"

echo "=== scenario 6: jq 不在 → 静かに exit 0 ==="
touch "$SUPABASE_MARKER_DIR/s6"
EMPTY_BIN="$WORK/emptybin"
mkdir -p "$EMPTY_BIN"
set +e
OUT="$(printf '%s' '{"session_id":"s6"}' | PATH="$EMPTY_BIN" /bin/bash "$SCRIPT")"
RC=$?
set -e
[ "$RC" -eq 0 ] && ok "jq 不在でも exit 0" || ng "jq 不在で exit $RC"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
