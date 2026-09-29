#!/bin/bash
# WHY: Codex のセッション開始時の入口（scripts/codex-session-start.sh）の回帰テスト。
#      仕様書 docs/specs/codex-hook-parity/07-claude-only-hooks.md の受け入れ条件のうち、
#      「欠けずにまとめる」「1 本が失敗しても残りは出る」「時間切れを黙って飛ばさない」
#      「問題が無いときは何も出ない」を固定する。
#
# WHY(入口を直接起動する): 本番（.codex/hooks.json の登録）は入口を直接起動する。
#      `bash x.sh` の形で呼ぶと、実行ビットが無くても動いてしまい、本番と違うものを測る（E-099）。
#
# 実行: bash scripts/codex-session-start.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$SCRIPT_DIR/codex-session-start.sh"
REAL_LIST="$SCRIPT_DIR/lib/codex-session-start-checks.txt"

pass=0
fail=0
ok() {
  echo "  OK: $1"
  pass=$((pass + 1))
}
ng() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=$((fail + 1))
}
assert_contains() {
  # $1 = ラベル、$2 = 探す文字列、$3 = 本文
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) ng "$1" "「$2」が無い: $3" ;;
  esac
}
assert_not_contains() {
  case "$3" in
    *"$2"*) ng "$1" "「$2」がある: $3" ;;
    *) ok "$1" ;;
  esac
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FIX="$WORK/checks"
mkdir -p "$FIX"

make_check() {
  # $1 = 名前、$2 以降 = 本文（1 引数 1 行）
  local name="$1"
  shift
  {
    echo '#!/usr/bin/env bash'
    printf '%s\n' "$@"
  } > "$FIX/$name"
  chmod +x "$FIX/$name"
}

make_check warn-a.sh \
  'cat > /dev/null' \
  'jq -n --arg msg "知らせ A" '"'"'{systemMessage: $msg, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $msg}}'"'"
make_check warn-b.sh \
  'cat > /dev/null' \
  'jq -n --arg msg "知らせ B" '"'"'{systemMessage: $msg, hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $msg}}'"'"
make_check quiet.sh \
  'cat > /dev/null' \
  'exit 0'
make_check exit1.sh \
  'cat > /dev/null' \
  'echo "途中まで出した"' \
  'exit 1'
make_check not-json.sh \
  'cat > /dev/null' \
  'echo "これは JSON ではない"'
make_check slow.sh \
  'cat > /dev/null' \
  'sleep 4' \
  'jq -n --arg msg "遅い知らせ" '"'"'{systemMessage: $msg}'"'"
make_check echo-session.sh \
  'SID="$(jq -r .session_id)"' \
  'jq -n --arg msg "session=$SID" '"'"'{systemMessage: $msg}'"'"
make_check echo-env.sh \
  'cat > /dev/null' \
  'jq -n --arg msg "claude_dir=${CLAUDE_PROJECT_DIR:-unset}" '"'"'{systemMessage: $msg}'"'"
make_check no-exec.sh \
  'cat > /dev/null' \
  'jq -n --arg msg "動いてはいけない" '"'"'{systemMessage: $msg}'"'"
chmod -x "$FIX/no-exec.sh"

INPUT='{"session_id":"s-1","source":"startup","hook_event_name":"SessionStart","cwd":"/tmp"}'

run_entry() {
  # $1 = 一覧の中身（1 行 1 本）、$2 = 標準入力（省略時は INPUT）、$3 = 上限の秒（省略時は既定）
  local list="$WORK/list.txt"
  printf '%s\n' "$1" > "$list"
  OUT="$(printf '%s' "${2:-$INPUT}" | CODEX_SESSION_START_CHECKS="$list" CODEX_SESSION_START_CHECK_DIR="$FIX" CODEX_SESSION_START_BUDGET_SECONDS="${3:-5}" "$ENTRY" 2>"$WORK/stderr")"
  RC=$?
  MSG="$(printf '%s' "$OUT" | jq -r '.systemMessage // empty' 2>/dev/null)"
}

echo "=== scenario 1: 入口が実在し、直接起動できる ==="
if [ -x "$ENTRY" ]; then
  ok "実行ビットがある"
else
  ng "実行ビットが無い（Codex は直接起動するので、無いと一度も動かない）"
fi

echo "=== scenario 2: 全部が黙るときは、何も出さない ==="
run_entry "quiet.sh"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
[ -z "$OUT" ] && ok "出力なし" || ng "出力なし" "$OUT"

echo "=== scenario 3: 1 本だけ知らせる ==="
run_entry "quiet.sh
warn-a.sh"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
[ "$MSG" = "知らせ A" ] && ok "知らせがそのまま出る" || ng "知らせがそのまま出る" "$MSG"
CTX="$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.additionalContext // empty')"
EVT="$(printf '%s' "$OUT" | jq -r '.hookSpecificOutput.hookEventName // empty')"
[ "$CTX" = "知らせ A" ] && ok "additionalContext にも同じ文が入る" || ng "additionalContext にも同じ文が入る" "$CTX"
[ "$EVT" = "SessionStart" ] && ok "hookEventName は SessionStart" || ng "hookEventName は SessionStart" "$EVT"

echo "=== scenario 4: 複数が知らせるとき、欠けずに一覧の順で出る ==="
run_entry "warn-b.sh
quiet.sh
warn-a.sh"
EXPECTED="知らせ B

知らせ A"
[ "$MSG" = "$EXPECTED" ] && ok "2 件が一覧の順で、空行で区切られて出る" || ng "2 件が一覧の順で出る" "$MSG"
if printf '%s' "$OUT" | jq -e 'type == "object"' >/dev/null 2>&1; then
  ok "出力は 1 つの JSON"
else
  ng "出力は 1 つの JSON" "$OUT"
fi

echo "=== scenario 5: 1 本が異常終了しても、残りは出て、名前を挙げて知らせる ==="
run_entry "exit1.sh
warn-a.sh"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
assert_contains "残りの知らせが出る" "知らせ A" "$MSG"
assert_contains "異常終了を名前で知らせる" "exit1.sh（終了コード 1）" "$MSG"
assert_not_contains "異常終了した点検の出力は混ぜない" "途中まで出した" "$MSG"

echo "=== scenario 6: JSON でない出力は、名前を挙げて知らせる ==="
run_entry "not-json.sh
warn-a.sh"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
assert_contains "残りの知らせが出る" "知らせ A" "$MSG"
assert_contains "JSON でないことを名前で知らせる" "not-json.sh（出力が JSON でない）" "$MSG"

echo "=== scenario 7: 起動できない点検（実行ビットなし・実体なし）を名前で知らせる ==="
run_entry "no-exec.sh
missing.sh
warn-a.sh"
assert_contains "実行ビットなしを知らせる" "no-exec.sh（実行ビットなし）" "$MSG"
assert_contains "実体なしを知らせる" "missing.sh（実体なし）" "$MSG"
assert_contains "本数を数える" "起動できなかった点検が 2 本" "$MSG"
assert_not_contains "実行ビットの無い点検を bash 経由で動かさない" "動いてはいけない" "$MSG"
assert_contains "残りの知らせが出る" "知らせ A" "$MSG"

echo "=== scenario 8: 時間切れのとき、打ち切った点検と動かせなかった点検を知らせる ==="
START="$(date +%s)"
run_entry "warn-a.sh
slow.sh
warn-b.sh
quiet.sh" "" 1
END="$(date +%s)"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
assert_contains "上限より前に動いた知らせは出る" "知らせ A" "$MSG"
assert_contains "打ち切った点検を名前で知らせる" "途中で打ち切った点検が 1 本" "$MSG"
assert_contains "打ち切った点検の名前" "  - slow.sh" "$MSG"
assert_contains "動かせなかった本数を知らせる" "動かせなかった点検が 2 本" "$MSG"
assert_contains "動かせなかった点検の名前" "  - warn-b.sh" "$MSG"
assert_not_contains "打ち切った点検の知らせは出ない" "遅い知らせ" "$MSG"
assert_not_contains "上限の後の点検は動かさない" "知らせ B" "$MSG"
ELAPSED=$((END - START))
if [ "$ELAPSED" -le 3 ]; then
  ok "遅い点検（4 秒）を待たずに終わる（${ELAPSED} 秒）"
else
  ng "遅い点検を待たずに終わる" "${ELAPSED} 秒かかった"
fi

echo "=== scenario 9: compact では動かさない（Claude Code 側の登録と同じ） ==="
run_entry "warn-a.sh" '{"session_id":"s-1","source":"compact"}'
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
[ -z "$OUT" ] && ok "出力なし" || ng "出力なし" "$OUT"
run_entry "warn-a.sh" '{"session_id":"s-1","source":"resume"}'
[ "$MSG" = "知らせ A" ] && ok "resume では動く" || ng "resume では動く" "$MSG"

echo "=== scenario 10: 各点検へ、同じ標準入力を渡す ==="
run_entry "echo-session.sh
echo-session.sh"
EXPECTED="session=s-1

session=s-1"
[ "$MSG" = "$EXPECTED" ] && ok "2 本とも session_id を読める" || ng "2 本とも session_id を読める" "$MSG"

echo "=== scenario 11: 一覧のコメントと空行を読み飛ばし、パスは受け付けない ==="
run_entry "# コメント

warn-a.sh   # 行末のコメント
../evil.sh
sub/dir.sh"
assert_contains "コメント付きの行の点検が動く" "知らせ A" "$MSG"
assert_contains "親フォルダへのパスを受け付けない" "../evil.sh（一覧の書き方が正しくない）" "$MSG"
assert_contains "下のフォルダへのパスを受け付けない" "sub/dir.sh（一覧の書き方が正しくない）" "$MSG"

echo "=== scenario 12: 一覧が無いときは、1 本も動かしていないと知らせる ==="
OUT="$(printf '%s' "$INPUT" | CODEX_SESSION_START_CHECKS="$WORK/no-such-list.txt" CODEX_SESSION_START_CHECK_DIR="$FIX" "$ENTRY" 2>/dev/null)"
RC=$?
MSG="$(printf '%s' "$OUT" | jq -r '.systemMessage // empty' 2>/dev/null)"
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
assert_contains "一覧が無いことを知らせる" "一覧が見つからない" "$MSG"

echo "=== scenario 13: jq が無いときは、黙って exit 0 ==="
NOJQ="$WORK/nojq-bin"
mkdir -p "$NOJQ"
for tool in bash cat dirname mktemp rm sed tr grep sleep env; do
  src="$(command -v "$tool" 2>/dev/null)"
  [ -n "$src" ] && ln -s "$src" "$NOJQ/$tool"
done
printf '%s\n' "warn-a.sh" > "$WORK/list.txt"
OUT="$(printf '%s' "$INPUT" | PATH="$NOJQ" CODEX_SESSION_START_CHECKS="$WORK/list.txt" CODEX_SESSION_START_CHECK_DIR="$FIX" "$ENTRY" 2>/dev/null)"
RC=$?
[ "$RC" -eq 0 ] && ok "exit 0" || ng "exit 0" "rc=$RC"
[ -z "$OUT" ] && ok "出力なし" || ng "出力なし" "$OUT"

echo "=== scenario 14: Claude Code の環境変数を、点検へ引き継がない ==="
# WHY: Claude Code の端末から Codex を起動すると、CLAUDE_PROJECT_DIR が別の worktree を
#      指したまま残る。点検がそれを信じると、いま開いているのと違う木を見て知らせる。
printf '%s\n' "echo-env.sh" > "$WORK/list.txt"
OUT="$(printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="/somewhere/else" CODEX_SESSION_START_CHECKS="$WORK/list.txt" CODEX_SESSION_START_CHECK_DIR="$FIX" "$ENTRY" 2>/dev/null)"
MSG="$(printf '%s' "$OUT" | jq -r '.systemMessage // empty' 2>/dev/null)"
[ "$MSG" = "claude_dir=unset" ] && ok "CLAUDE_PROJECT_DIR は渡らない" || ng "CLAUDE_PROJECT_DIR は渡らない" "$MSG"

echo "=== scenario 15: 標準エラーに何も出さない（打ち切りのときも） ==="
run_entry "slow.sh" "" 1
if [ -s "$WORK/stderr" ]; then
  ng "標準エラーが空" "$(cat "$WORK/stderr")"
else
  ok "標準エラーが空"
fi

echo "=== scenario 16: 点検が早く終われば、上限の秒数を待たずに終わり、見張り役を残さない ==="
# WHY: 見張り役の sleep が標準出力を握ったまま残ると、Codex は hook の出力が閉じるのを
#      上限の秒数まで待つ。上限を 97 秒という他で使わない値にして、残った sleep を名前で探す。
START="$(date +%s)"
run_entry "quiet.sh
warn-a.sh" "" 97
END="$(date +%s)"
ELAPSED=$((END - START))
[ "$MSG" = "知らせ A" ] && ok "知らせが出る" || ng "知らせが出る" "$MSG"
if [ "$ELAPSED" -le 3 ]; then
  ok "上限（97 秒）を待たずに終わる（${ELAPSED} 秒）"
else
  ng "上限を待たずに終わる" "${ELAPSED} 秒かかった"
fi
LEFT="$(ps -A -o command 2>/dev/null | grep -c '^sleep 97$' || true)"
if [ "$LEFT" = "0" ]; then
  ok "見張り役の sleep が残っていない"
else
  ng "見張り役の sleep が残っていない" "${LEFT} 個残っている"
fi

echo "=== scenario 17: 本物の一覧の各行が、実在して実行できる ==="
if [ ! -f "$REAL_LIST" ]; then
  ng "一覧（scripts/lib/codex-session-start-checks.txt）がある"
else
  COUNT=0
  BAD=""
  while IFS= read -r line || [ -n "$line" ]; do
    name="${line%%#*}"
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -z "$name" ] && continue
    COUNT=$((COUNT + 1))
    if [ ! -f "$SCRIPT_DIR/$name" ]; then
      BAD="${BAD} ${name}（実体なし）"
    elif [ ! -x "$SCRIPT_DIR/$name" ]; then
      BAD="${BAD} ${name}（実行ビットなし）"
    fi
  done < "$REAL_LIST"
  if [ "$COUNT" -ge 1 ]; then
    ok "一覧から ${COUNT} 本を読めた（走査が空振りしていない）"
  else
    ng "一覧から 1 本も読めない"
  fi
  [ -z "$BAD" ] && ok "すべて実在し、実行できる" || ng "すべて実在し、実行できる" "$BAD"
  DUP="$(grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$REAL_LIST" | sort | uniq -d)"
  [ -z "$DUP" ] && ok "同じ点検を 2 回書いていない" || ng "同じ点検を 2 回書いていない" "$DUP"
fi

echo "=== scenario 18: 一覧の点検は、状態ファイルを書かない（共存の原則 7） ==="
# WHY: Claude Code と Codex が同じ状態ファイルを書くと、片方の「知らせ済み」がもう片方を黙らせる。
#      check-stale-worktrees.sh は .aidd/ に「知らせ済み」の印を書くので、一覧に入れていない。
if [ -f "$REAL_LIST" ]; then
  WRITERS=""
  while IFS= read -r line || [ -n "$line" ]; do
    name="${line%%#*}"
    name="$(printf '%s' "$name" | tr -d '[:space:]')"
    [ -z "$name" ] && continue
    [ -f "$SCRIPT_DIR/$name" ] || continue
    if grep -q -E -e 'mktemp' -e 'mkdir' -e 'MARKER_FILE' "$SCRIPT_DIR/$name"; then
      WRITERS="${WRITERS} ${name}"
    fi
  done < "$REAL_LIST"
  [ -z "$WRITERS" ] && ok "書き込む点検なし" || ng "書き込む点検が一覧にある" "$WRITERS"
fi

echo ""
echo "結果: ${pass} OK / ${fail} NG"
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
