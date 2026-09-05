#!/bin/bash
# WHY(issue #738): scripts/harvest-journal-events.sh は Stop hook として毎ターン走り、以前は
#      vkumai 由来の全 project dir（実測 43 件）で node を起動していた（2.8 秒/Stop、追記 0 件）。
#      「前回収穫（state ファイルの mtime）より新しいファイルを wf_* 配下に持つ dir だけ走査する」
#      間引きと、「収穫 0 件の dir は出力しない」を固定する。実環境の ~/.claude/projects/ は読まず、
#      AIDD_JOURNAL_PROJECT_DIR / AIDD_LOG_DIR / HARVEST_STATE_FILE で一時ディレクトリへ差し替える。
#
# 実行: bash scripts/harvest-journal-events.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/harvest-journal-events.sh"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PROJ="$WORK/proj"
WF="$PROJ/sess-1/subagents/workflows/wf_abc"
mkdir -p "$WF" "$WORK/logs"
printf '{"agentType":"reviewer"}\n' > "$WF/agent-a1.meta.json"
printf '{"type":"assistant","timestamp":"2026-09-05T00:00:00Z","message":{"content":[{"type":"text","text":"done"}]}}\n' > "$WF/agent-a1.jsonl"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
contains() { if printf '%s\n' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }

run_harvest() {
  # $@: 追加引数。stdout を OUT、stderr を ERR に入れる
  set +e
  OUT="$(AIDD_JOURNAL_PROJECT_DIR="$PROJ" AIDD_LOG_DIR="$WORK/logs" HARVEST_STATE_FILE="$WORK/state" HARVEST_VERBOSE=1 \
    bash "$SCRIPT" "$@" 2> "$WORK/err.txt")"
  EXIT_CODE=$?
  set -e
  ERR="$(cat "$WORK/err.txt")"
}

echo "=== scenario 1: state 無し（初回） → 全 dir を走査し、state を作る ==="
run_harvest
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "exit $EXIT_CODE" "$ERR"
contains "$ERR" "走査 1 dir / スキップ 0 dir" "初回は走査する"
[ -f "$WORK/state" ] && ok "state ファイルが作られる" || ng "state ファイルが無い"

echo "=== scenario 2: 前回以降に更新が無い → node を起動せずスキップし、stdout は無出力 ==="
sleep 1
run_harvest
contains "$ERR" "走査 0 dir / スキップ 1 dir" "更新が無ければスキップする"
[ -z "$OUT" ] && ok "追記 0 件のときは stdout に何も出さない" || ng "stdout に出力がある" "$OUT"

echo "=== scenario 3: wf_* 配下に新しいファイルが増えた → その dir だけ再走査する ==="
sleep 1
printf '{"agentType":"implementer"}\n' > "$WF/agent-a2.meta.json"
printf '{"type":"assistant","timestamp":"2026-09-05T00:01:00Z","message":{"content":[{"type":"text","text":"done"}]}}\n' > "$WF/agent-a2.jsonl"
run_harvest
contains "$ERR" "走査 1 dir / スキップ 0 dir" "新しいファイルがあれば走査する"
contains "$OUT" "件追記" "追記があれば stdout に結果を出す"

echo "=== scenario 4: --force → 更新が無くても全 dir を走査する ==="
sleep 1
run_harvest --force
contains "$ERR" "走査 1 dir / スキップ 0 dir" "--force で間引きを無効化"

echo "=== scenario 5: wf_* 以外のファイル更新（transcript 本体など）では再走査しない ==="
sleep 1
printf '{"type":"user"}\n' > "$PROJ/sess-1.jsonl"
run_harvest
contains "$ERR" "走査 0 dir / スキップ 1 dir" "wf_* 配下でない更新は無視する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
