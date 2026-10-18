#!/usr/bin/env bash
# WHY: scripts/lib/log-hook-decision.sh（止める hook が deny / ask / warn を出した回を
#      logs/hook-decisions.jsonl に 1 行残す関数）の回帰テスト。仕様は docs/specs/hook-decision-log.md。
#
#      いちばん大事なのは「記録が判定を壊さない」こと。書けない・jq が無い・呼び出し側が
#      set -e でも、関数は 0 を返し stdout / stderr に何も出さない（RED 方向を 2 つ持つ）。
#      次に大事なのは「秘密を書かない」こと。target は呼び出し側が先頭の語だけ渡す約束だが、
#      渡された入力 JSON のコマンド本文を関数が勝手に書き出していないかをここで見る。
#
# 実行: bash scripts/lib/log-hook-decision.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/log-hook-decision.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then echo "  OK: $label"; else echo "  NG: $label (expected=$expected actual=$actual)"; fail=1; fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then echo "  OK: $label"; else echo "  NG: $label"; echo "      expected: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then echo "  NG: $label (found: $needle)"; fail=1; else echo "  OK: $label"; fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then echo "  OK: $label"; else echo "  NG: $label (actual=$actual)"; fail=1; fi
}

# 関数を source して 1 回呼び、stdout・stderr・終了コードを別々に取る。
# 第 1 引数は記録先。残りは log_hook_decision の引数そのまま。
call() { # $1=log_file, $2..=args
  local log_file="$1"; shift
  set +e
  OUT="$(AIDD_HOOK_DECISION_LOG_FILE="$log_file" bash -c '
    set -euo pipefail
    source "$1"; shift
    log_hook_decision "$@"
    echo "alive"
  ' _ "$LIB" "$@" 2>"$WORK/stderr")"
  RC=$?
  set -e
  ERR="$(cat "$WORK/stderr")"
}

INPUT_PLAIN='{"tool_name":"Bash","session_id":"sess-001","cwd":"/tmp","tool_input":{"command":"dbtool push"}}'

echo "=== scenario 1: 止めた回が 1 行になり、必須の項目が入る ==="
LOG1="$WORK/one/hook-decisions.jsonl"
call "$LOG1" check-direct-ddl-execution deny db_push_without_local Bash dbtool "$INPUT_PLAIN"
assert_eq "$RC" "0" "exit 0"
assert_eq "$OUT" "alive" "stdout には呼び出し側の出力しか無い（関数は何も出さない）"
assert_empty "$ERR" "stderr に何も出ない"
assert_eq "$(wc -l <"$LOG1" | tr -d ' ')" "1" "1 行だけ増える"
LINE="$(cat "$LOG1")"
assert_eq "$(jq -r '.hook' <<<"$LINE")" "check-direct-ddl-execution" "hook"
assert_eq "$(jq -r '.decision' <<<"$LINE")" "deny" "decision"
assert_eq "$(jq -r '.rule' <<<"$LINE")" "db_push_without_local" "rule"
assert_eq "$(jq -r '.tool_name' <<<"$LINE")" "Bash" "tool_name"
assert_eq "$(jq -r '.target' <<<"$LINE")" "dbtool" "target"
assert_eq "$(jq -r '.session_id' <<<"$LINE")" "sess-001" "session_id は入力 JSON から取る"
assert_eq "$(jq -r '.timestamp | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")' <<<"$LINE")" "true" "timestamp は UTC 秒まで"
call "$LOG1" check-skip-marker-write ask skip_marker Write ".claude/.verify-state/x.skip" "$INPUT_PLAIN"
assert_eq "$(wc -l <"$LOG1" | tr -d ' ')" "2" "2 回目は追記される（上書きしない）"

echo "=== scenario 2 (RED): 記録先に書けなくても 0 を返し、何も出さない ==="
# 親を「ディレクトリでなく普通のファイル」にする。mkdir -p も >> も失敗する。root でも失敗する
printf 'not a dir' > "$WORK/notadir"
call "$WORK/notadir/sub/hook-decisions.jsonl" check-direct-ddl-execution deny direct_exec Bash psql "$INPUT_PLAIN"
assert_eq "$RC" "0" "exit 0（set -euo pipefail の呼び出し側が生きている）"
assert_eq "$OUT" "alive" "呼び出し側の後続が実行される"
assert_empty "$ERR" "stderr に何も出ない"

echo "=== scenario 3 (RED): jq が無くても 0 を返し、何も出さない。記録もしない ==="
EMPTY_BIN="$WORK/emptybin"
mkdir -p "$EMPTY_BIN"
for tool in bash cat dirname mkdir date git wc; do
  p="$(command -v "$tool")"; [ -n "$p" ] && ln -s "$p" "$EMPTY_BIN/$tool"
done
LOG3="$WORK/three/hook-decisions.jsonl"
set +e
OUT="$(PATH="$EMPTY_BIN" AIDD_HOOK_DECISION_LOG_FILE="$LOG3" bash -c '
  set -euo pipefail
  source "$1"; shift
  log_hook_decision "$@"
  echo "alive"
' _ "$LIB" check-direct-ddl-execution deny direct_exec Bash psql "$INPUT_PLAIN" 2>"$WORK/stderr")"
RC=$?
set -e
assert_eq "$RC" "0" "exit 0"
assert_eq "$OUT" "alive" "呼び出し側の後続が実行される"
assert_empty "$(cat "$WORK/stderr")" "stderr に何も出ない"
assert_eq "$([ -e "$LOG3" ] && echo exists || echo none)" "none" "記録ファイルは作られない"

echo "=== scenario 4: 入力 JSON のコマンド本文は書き出さない（target は呼び出し側の 1 語だけ） ==="
INPUT_SECRET='{"tool_name":"Bash","session_id":"sess-002","cwd":"/tmp","tool_input":{"command":"psql \"postgres://u:TopSecretPw@h/db\" -c \"drop table x\""}}'
LOG4="$WORK/four/hook-decisions.jsonl"
call "$LOG4" check-direct-ddl-execution deny direct_exec Bash psql "$INPUT_SECRET"
assert_not_contains "$(cat "$LOG4")" "TopSecretPw" "接続文字列のパスワードが行に無い"
assert_not_contains "$(cat "$LOG4")" "drop table" "SQL 本文が行に無い"
assert_eq "$(jq -r '.target' <<<"$(cat "$LOG4")")" "psql" "target は psql だけ"

echo "=== scenario 5: caller の決め方（環境変数 → apply_patch → CLAUDE_PROJECT_DIR → unknown） ==="
LOG5="$WORK/five/hook-decisions.jsonl"
set +e
AIDD_HOOK_CALLER=codex AIDD_HOOK_DECISION_LOG_FILE="$LOG5" bash -c 'source "$1"; shift; log_hook_decision "$@"' _ "$LIB" check-skip-marker-write ask skip_marker Write x.skip "$INPUT_PLAIN"
env -u AIDD_HOOK_CALLER -u CLAUDE_PROJECT_DIR AIDD_HOOK_DECISION_LOG_FILE="$LOG5" bash -c 'source "$1"; shift; log_hook_decision "$@"' _ "$LIB" check-dependency-change ask dependency_change_file apply_patch package.json "$INPUT_PLAIN"
env -u AIDD_HOOK_CALLER CLAUDE_PROJECT_DIR=/tmp/proj AIDD_HOOK_DECISION_LOG_FILE="$LOG5" bash -c 'source "$1"; shift; log_hook_decision "$@"' _ "$LIB" check-run-manifest-presence warn manifest_missing Edit src/lib/auth/x.ts "$INPUT_PLAIN"
env -u AIDD_HOOK_CALLER -u CLAUDE_PROJECT_DIR AIDD_HOOK_DECISION_LOG_FILE="$LOG5" bash -c 'source "$1"; shift; log_hook_decision "$@"' _ "$LIB" check-direct-ddl-execution deny direct_exec Bash psql "$INPUT_PLAIN"
set -e
assert_eq "$(sed -n '1p' "$LOG5" | jq -r '.caller')" "codex" "AIDD_HOOK_CALLER=codex → codex"
assert_eq "$(sed -n '2p' "$LOG5" | jq -r '.caller')" "codex" "tool_name=apply_patch → codex"
assert_eq "$(sed -n '3p' "$LOG5" | jq -r '.caller')" "claude" "CLAUDE_PROJECT_DIR あり → claude"
assert_eq "$(sed -n '4p' "$LOG5" | jq -r '.caller')" "unknown" "手がかり無し → unknown（当てずっぽうで claude にしない）"
assert_eq "$(sed -n '3p' "$LOG5" | jq -r '.decision')" "warn" "warn も 3 値の 1 つとして書ける"

echo "=== scenario 6: agent_type と branch。無ければ空 / unknown ==="
REPO="$WORK/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" -c user.name=t -c user.email=t@example.com -c core.hooksPath=/dev/null commit -q --allow-empty -m init
git -C "$REPO" checkout -q -b fixture-branch
INPUT_AGENT="$(jq -nc --arg cwd "$REPO" '{tool_name:"Bash",agent_type:"sweep-ui",cwd:$cwd,tool_input:{command:"rm -rf x"}}')"
LOG6="$WORK/six/hook-decisions.jsonl"
call "$LOG6" check-readonly-bash deny readonly_role Bash rm "$INPUT_AGENT"
assert_eq "$(jq -r '.agent_type' <<<"$(cat "$LOG6")")" "sweep-ui" "agent_type は入力 JSON から取る"
assert_eq "$(jq -r '.branch' <<<"$(cat "$LOG6")")" "fixture-branch" "branch は入力の cwd のリポジトリから取る"
assert_eq "$(jq -r '.session_id' <<<"$(cat "$LOG6")")" "" "session_id が無ければ空"
INPUT_NOGIT='{"tool_name":"Bash","cwd":"/","tool_input":{"command":"psql"}}'
call "$LOG6" check-direct-ddl-execution deny direct_exec Bash psql "$INPUT_NOGIT"
assert_eq "$(sed -n '2p' "$LOG6" | jq -r '.branch')" "unknown" "git リポジトリでなければ unknown"

echo "=== scenario 7: 記録先の既定は resolve_log_dir（cwd 相対の logs/ ではない） ==="
if grep -qF 'resolve_log_dir' "$LIB"; then
  echo "  OK: resolve_log_dir を使っている"
else
  echo "  NG: resolve_log_dir を使っていない（scripts/check-log-dir-resolution.test.sh の規則）"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
