#!/usr/bin/env bash
set -uo pipefail

# WHY: 2026-09-30、仕様書 docs/specs/codex-hook-parity/07-claude-only-hooks.md。
#      同じ人が同じリポジトリを触っていても、Claude Code ではセッションの始まりに
#      23 本の点検が動き、Codex では 3 本しか動いていなかった。リポジトリの状態を見るだけの
#      点検（どのツールから動かしても同じ結果になるもの）を、Codex でも動かす。
#
# WHY(入口を 1 本にまとめる): Codex は hook を 1 件ずつ人が信頼する。点検を 1 本ずつ登録すると
#      本数ぶんの操作が要り、足すたびに信頼し直しになる。入口を 1 本にして、動かす点検は
#      一覧（scripts/lib/codex-session-start-checks.txt）で決める。
#      信頼は hook の登録内容から計算され、スクリプトの中身は元から含まれない（0.1.4 の配布で実測）
#      ので、入口を分けても分けなくても、中身の変更が確認されないことは変わらない。
#
# WHY(黙って飛ばさない): 点検が起動できない・異常終了した・時間切れで動かせなかった、は
#      どれも名前を挙げて知らせる。実行ビットの無い hook 3 本が 3 週間、誰にも気づかれずに
#      動いていなかった（E-099）。「動かなかった」が見えないと、静かなことを無事と読んでしまう。
#
# WHY(警告専用・jq 不在時は静かに終わる): 作業を止めない hook なので、jq が無い環境では
#      知らせが出ないだけにする（既存の check-*-staleness.sh と同じ設計。issue #636）。
#
# 環境変数（テスト用の注入ポイント）:
#   CODEX_SESSION_START_CHECKS          動かす点検の一覧（既定 scripts/lib/codex-session-start-checks.txt）
#   CODEX_SESSION_START_CHECK_DIR       点検の置き場所（既定 このスクリプトと同じ場所）
#   CODEX_SESSION_START_BUDGET_SECONDS  合計時間の上限（既定 5。整数の秒）
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKS_FILE="${CODEX_SESSION_START_CHECKS:-$SCRIPT_DIR/lib/codex-session-start-checks.txt}"
CHECK_DIR="${CODEX_SESSION_START_CHECK_DIR:-$SCRIPT_DIR}"
BUDGET="${CODEX_SESSION_START_BUDGET_SECONDS:-5}"
case "$BUDGET" in
  ''|*[!0-9]*) BUDGET=5 ;;
esac

HOOK_INPUT="$(cat 2>/dev/null || true)"

# WHY: Claude Code 側の登録は startup / resume / clear / fork だけで、compact では動かしていない。
#      会話を縮めるたびに同じ知らせが出ると、人は読まなくなる。
SOURCE="$(printf '%s' "$HOOK_INPUT" | jq -r '.source // empty' 2>/dev/null || true)"
[ "$SOURCE" = "compact" ] && exit 0

NL='
'
MESSAGES=""
NOT_LAUNCHED=""
FAILED=""
SKIPPED=""
TIMED_OUT=""

append_line() {
  # $1 = これまでの値、$2 = 足す 1 行。bash 3.2 は空の配列を set -u の下で展開できないので、文字列で積む
  if [ -z "$1" ]; then
    printf '%s' "$2"
  else
    printf '%s%s%s' "$1" "$NL" "$2"
  fi
}

emit() {
  # $1 = 知らせる文
  jq -n --arg msg "$1" '{
    systemMessage: $msg,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
  }'
}

if [ ! -f "$CHECKS_FILE" ]; then
  emit "Codex のセッション開始時の点検: 動かす点検の一覧が見つからないため、1 本も動かしていません（${CHECKS_FILE}）。"
  exit 0
fi

# WHY: Claude Code の端末から Codex を起動すると、Claude Code 用の変数が別の worktree を指したまま
#      残る。点検はこの変数があればそちらを根にするので、いま開いているのと違う木を見て知らせる。
#      外しておけば、点検は自分の置き場所から根を決める。
unset CLAUDE_PROJECT_DIR

WORK_DIR="$(mktemp -d 2>/dev/null)" || exit 0
trap 'rm -rf "$WORK_DIR"' EXIT

run_with_deadline() {
  # $1 = 残り秒数、$2 = 点検のパス、$3 = 出力の置き場所。戻り値は点検の終了コード（時間切れは 124）
  local limit="$1" script="$2" out="$3" pid watchdog rc flag
  flag="$WORK_DIR/timed-out"
  rm -f "$flag"
  printf '%s' "$HOOK_INPUT" > "$WORK_DIR/stdin"
  "$script" < "$WORK_DIR/stdin" > "$out" 2>/dev/null &
  pid=$!
  # WHY(見張り役の出力を捨て、sleep も一緒に止める): 見張り役だけを止めると、中の sleep は残る。
  #      標準出力を握ったまま残ると、Codex は hook の出力が閉じるのを sleep が終わるまで待つ。
  #      握っていなくても、点検の本数ぶんの sleep が上限の秒数まで残る。
  (
    sleep "$limit" &
    sleeper=$!
    trap 'kill "$sleeper" 2>/dev/null; exit 0' TERM
    wait "$sleeper"
    : > "$flag"
    kill -TERM "$pid" 2>/dev/null
  ) < /dev/null > /dev/null 2>&1 &
  watchdog=$!
  wait "$pid" 2>/dev/null
  rc=$?
  kill "$watchdog" 2>/dev/null
  wait "$watchdog" 2>/dev/null
  if [ -f "$flag" ]; then
    return 124
  fi
  return "$rc"
}

SECONDS=0
while IFS= read -r line || [ -n "$line" ]; do
  name="${line%%#*}"
  name="$(printf '%s' "$name" | tr -d '[:space:]')"
  [ -z "$name" ] && continue

  # 一覧に書けるのは、点検の置き場所の直下にあるスクリプトの名前だけ（パスは書けない）
  case "$name" in
    */*|.*|*[!A-Za-z0-9._-]*)
      NOT_LAUNCHED="$(append_line "$NOT_LAUNCHED" "${name}（一覧の書き方が正しくない）")"
      continue
      ;;
  esac

  if [ "$SECONDS" -ge "$BUDGET" ]; then
    SKIPPED="$(append_line "$SKIPPED" "$name")"
    continue
  fi

  script="$CHECK_DIR/$name"
  if [ ! -f "$script" ]; then
    NOT_LAUNCHED="$(append_line "$NOT_LAUNCHED" "${name}（実体なし）")"
    continue
  fi
  if [ ! -x "$script" ]; then
    NOT_LAUNCHED="$(append_line "$NOT_LAUNCHED" "${name}（実行ビットなし）")"
    continue
  fi

  out="$WORK_DIR/out"
  : > "$out"
  run_with_deadline "$((BUDGET - SECONDS))" "$script" "$out"
  rc=$?

  if [ "$rc" -eq 124 ]; then
    TIMED_OUT="$(append_line "$TIMED_OUT" "$name")"
    continue
  fi
  if [ "$rc" -ne 0 ]; then
    FAILED="$(append_line "$FAILED" "${name}（終了コード ${rc}）")"
    continue
  fi
  [ -s "$out" ] || continue

  msg="$(jq -r '.systemMessage // empty' "$out" 2>/dev/null)"
  if [ $? -ne 0 ]; then
    FAILED="$(append_line "$FAILED" "${name}（出力が JSON でない）")"
    continue
  fi
  [ -z "$msg" ] && continue
  if [ -z "$MESSAGES" ]; then
    MESSAGES="$msg"
  else
    MESSAGES="${MESSAGES}${NL}${NL}${msg}"
  fi
done < "$CHECKS_FILE"

bullet_list() {
  # $1 = 1 行 1 件の文字列。各行の頭に「  - 」を付ける
  printf '%s\n' "$1" | sed 's/^/  - /'
}

count_lines() {
  printf '%s\n' "$1" | grep -c .
}

NOTICE=""
if [ -n "$NOT_LAUNCHED" ]; then
  NOTICE="$(append_line "$NOTICE" "- 起動できなかった点検が $(count_lines "$NOT_LAUNCHED") 本あります。")"
  NOTICE="$(append_line "$NOTICE" "$(bullet_list "$NOT_LAUNCHED")")"
fi
if [ -n "$FAILED" ]; then
  NOTICE="$(append_line "$NOTICE" "- 異常終了した点検が $(count_lines "$FAILED") 本あります。")"
  NOTICE="$(append_line "$NOTICE" "$(bullet_list "$FAILED")")"
fi
if [ -n "$TIMED_OUT" ]; then
  NOTICE="$(append_line "$NOTICE" "- 合計 ${BUDGET} 秒の上限に達し、途中で打ち切った点検が $(count_lines "$TIMED_OUT") 本あります。")"
  NOTICE="$(append_line "$NOTICE" "$(bullet_list "$TIMED_OUT")")"
fi
if [ -n "$SKIPPED" ]; then
  NOTICE="$(append_line "$NOTICE" "- 合計 ${BUDGET} 秒の上限に達し、動かせなかった点検が $(count_lines "$SKIPPED") 本あります。")"
  NOTICE="$(append_line "$NOTICE" "$(bullet_list "$SKIPPED")")"
fi

if [ -n "$NOTICE" ]; then
  NOTICE="Codex のセッション開始時の点検: 結果の出ていない点検があります（知らせが無いことを、問題が無いことと読まないでください）。${NL}${NOTICE}"
  if [ -z "$MESSAGES" ]; then
    MESSAGES="$NOTICE"
  else
    MESSAGES="${MESSAGES}${NL}${NL}${NOTICE}"
  fi
fi

[ -z "$MESSAGES" ] && exit 0

emit "$MESSAGES"
exit 0
