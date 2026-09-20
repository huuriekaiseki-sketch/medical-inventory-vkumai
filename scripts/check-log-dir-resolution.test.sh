#!/bin/bash
# WHY(issue #805): 記録する側（log-*.sh・verify-claims.sh）は、全 worktree 共有の logs/（resolve_log_dir。issue #546）へ
# 書く。ところが**読む側**の一部は、既定のログ位置を cwd 相対の "logs/..." のままにしていた。git worktree では
# 書く場所と読む場所が食い違い、読む側はほぼ空の worktree 直下を見る。壊れ方は 1 本ごとに違う（2026-09-20 に実測）:
#   - check-find-av-precision-recorded.sh … 記録してあっても「未記録」と警告する（誤警告）
#   - check-aidd-stats-recorded.sh        … Workflow の形跡が見えないので、start の呼び忘れがあっても黙る（見逃し）
#   - check-verify-claims-fail-open-streak.sh … 連続 fail-open を見逃す
#   - snapshot-agent-baseline.sh          … 別の（ほぼ空の）ログから baseline を作る
#   - verify-agent-progress-transcript.sh … --log-file は共有側を渡すのに、骨格ログだけ TS の cwd 相対の既定に落ちていた
#   - subagent-statusline-debug-collector.sh … worktree 直下に書く（実測用の一時ツール）
#
# 同じ漏れは issue #546 → PR #804 → 本 issue と 3 回続いた。個別に直すだけでは 4 回目が出るので、
# **cwd 相対の logs/ を既定にする書き方そのものを落とす**（scenario 1）。
#
# WHY(既定の場所を測る): 各 hook の既存テストは、ログの場所を環境変数で差し替えて動かす。そのため
# 「差し替えなかったときにどこを読むか」は、どのテストも通っていなかった。ここでは差し替えずに動かす。
#
# 実行: bash scripts/check-log-dir-resolution.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "  OK: $label"
  else
    echo "  NG: $label"
    echo "      expected to find: $needle"
    echo "      actual: $haystack"
    fail=1
  fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}

# cwd 相対・スクリプト位置相対の logs/ を既定にしている行を列挙する。$1=根
# コメント行と *.test.sh は数えない（テストはおとりのログを worktree 直下に置くため）
scan_relative_logs_default() {
  local root="$1"
  grep -rnE --include='*.sh' --exclude='*.test.sh' --exclude-dir=node_modules --exclude-dir=dist \
    -e '(:-|=)["'"'"']?logs/' \
    -e '(:-|=)["'"'"']?\$\{?(REPO_ROOT|REPO_DIR|PROJECT_ROOT|SCRIPT_DIR)\}?(/\.\.)?/logs' \
    "$root" 2>/dev/null \
    | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true
}

echo "=== scenario 1: 実態に、cwd 相対の logs/ を既定にするシェルが無い ==="
HITS="$(scan_relative_logs_default "$SCRIPT_DIR")"
if [ -z "$HITS" ]; then
  echo "  OK: cwd 相対の logs/ の既定は 0 件"
else
  echo "  NG: cwd 相対の logs/ を既定にしている"
  while IFS= read -r line; do echo "      $line"; done <<<"$HITS"
  echo "      直し方: source \"\$SCRIPT_DIR/lib/resolve-log-dir.sh\" して \"\$(resolve_log_dir)/xxx.jsonl\" を既定にする"
  fail=1
fi

echo "=== scenario 2: 走査が空振りしていない・fixture で検知できる（C-044） ==="
SCANNED="$(find "$SCRIPT_DIR" -type f -name '*.sh' -not -name '*.test.sh' -not -path '*/node_modules/*' | wc -l | tr -d ' ')"
if [ "$SCANNED" -ge 50 ]; then
  echo "  OK: *.sh を ${SCANNED} 本走査できている"
else
  echo "  NG: 走査できた本数が少なすぎる（${SCANNED} 本）"
  fail=1
fi
mkdir -p "$WORK_DIR/fx/bad" "$WORK_DIR/fx/good"
printf '%s\n' 'LOG_FILE="logs/a.jsonl"' > "$WORK_DIR/fx/bad/a.sh"
printf '%s\n' 'LOG_FILE="${X_LOG:-logs/b.jsonl}"' > "$WORK_DIR/fx/bad/b.sh"
printf '%s\n' 'LOG_FILE="$REPO_ROOT/logs/c.jsonl"' > "$WORK_DIR/fx/bad/c.sh"
printf '%s\n' '# 説明: 以前は LOG_FILE="logs/d.jsonl" だった' 'LOG_FILE="${X_LOG:-$(resolve_log_dir)/d.jsonl}"' > "$WORK_DIR/fx/good/d.sh"
assert_eq "$(scan_relative_logs_default "$WORK_DIR/fx/bad" | wc -l | tr -d ' ')" "3" "3 通りの書き方をすべて検知する"
assert_eq "$(scan_relative_logs_default "$WORK_DIR/fx/good" | wc -l | tr -d ' ')" "0" "resolve_log_dir 経由とコメントは誤検知しない"

# --- ここから: 本物の git worktree の中で、ログの場所を差し替えずに動かす ---
GIT_SANDBOX="$(mkdir -p "$WORK_DIR/git-sandbox" && cd "$WORK_DIR/git-sandbox" && pwd -P)"
MAIN_REPO="$GIT_SANDBOX/main"
LINKED_WT="$GIT_SANDBOX/wt"
mkdir -p "$MAIN_REPO/scripts/lib"
cp "$SCRIPT_DIR/check-verify-claims-fail-open-streak.sh" "$SCRIPT_DIR/check-find-av-precision-recorded.sh" \
  "$SCRIPT_DIR/check-aidd-stats-recorded.sh" "$SCRIPT_DIR/subagent-statusline-debug-collector.sh" \
  "$MAIN_REPO/scripts/"
cp "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$MAIN_REPO/scripts/lib/"
git -C "$MAIN_REPO" init -q
git -C "$MAIN_REPO" add -A
git -C "$MAIN_REPO" -c user.name=test -c user.email=test@example.com -c core.hooksPath=/dev/null \
  commit -q -m init
git -C "$MAIN_REPO" worktree add -q "$LINKED_WT" -b wt-branch
mkdir -p "$MAIN_REPO/logs" "$LINKED_WT/logs"

SESSION="session-805"
SESSION_START_ISO="2026-07-22T04:00:00.123Z"
TRANSCRIPT="$WORK_DIR/transcript.jsonl"
printf '{"type":"user","timestamp":"%s"}\n' "$SESSION_START_ISO" > "$TRANSCRIPT"

echo "=== scenario 3: 連続 fail-open の検知器は、worktree から動かしても共有の logs/ を読む ==="
# 共有側: 5 回連続 fail_open（鳴るべき）。おとり（worktree 直下）: 5 回 pass（こちらを読むと鳴らない）
for _ in 1 2 3 4 5; do
  printf '%s\n' '{"event":"fail_open","verifier_called":true}' >> "$MAIN_REPO/logs/verify-claims-observability.jsonl"
  printf '%s\n' '{"event":"pass","verifier_called":true}' >> "$LINKED_WT/logs/verify-claims-observability.jsonl"
done
set +e
OUT="$(cd "$LINKED_WT" && env -u AIDD_LOG_DIR bash "$LINKED_WT/scripts/check-verify-claims-fail-open-streak.sh" 2>&1)"
CODE=$?
set -e
assert_eq "$CODE" "1" "共有側の連続 fail-open を見つけて exit 1（おとりを読むと exit 0 になる）"
assert_contains "$OUT" "連続でfail-open" "連続 fail-open の警告が出る"

echo "=== scenario 4: Find→AV の記録の確認は、worktree から動かしても共有の logs/ を読む ==="
# 共有側: セッション開始以降の記録あり（黙るべき）。おとり: ファイル無し（こちらを読むと「未記録」と誤警告する）
WORKFLOWS_DIR="$WORK_DIR/workflows"
mkdir -p "$WORKFLOWS_DIR"
jq -n '{result: {findAvPrecision: {verifiedCount: 5}}}' > "$WORKFLOWS_DIR/wf_a.json"
printf '{"timestamp":"%s","verifiedCount":5}\n' "2026-07-22T04:30:00Z" > "$MAIN_REPO/logs/find-av-precision.jsonl"
set +e
OUT="$(env -u AIDD_LOG_DIR -u FIND_AV_PRECISION_CHECK_LOG_FILE \
  CLAUDE_PROJECT_DIR="$LINKED_WT" \
  FIND_AV_PRECISION_CHECK_SESSION_ID="$SESSION" \
  FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
  FIND_AV_PRECISION_CHECK_MARKER_FILE="$WORK_DIR/find-av-marker.json" \
  bash "$LINKED_WT/scripts/check-find-av-precision-recorded.sh" < /dev/null 2>&1)"
CODE=$?
set -e
assert_eq "$CODE" "0" "exit 0"
assert_empty "$OUT" "記録してあるので黙る（おとりを読むと「未記録」と誤警告する）"
# 対: 共有側から記録を消せば、ちゃんと警告する（「常に黙る」ではないことを見る）
rm -f "$MAIN_REPO/logs/find-av-precision.jsonl"
set +e
OUT="$(env -u AIDD_LOG_DIR -u FIND_AV_PRECISION_CHECK_LOG_FILE \
  CLAUDE_PROJECT_DIR="$LINKED_WT" \
  FIND_AV_PRECISION_CHECK_SESSION_ID="$SESSION" \
  FIND_AV_PRECISION_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  FIND_AV_PRECISION_CHECK_WORKFLOWS_DIR="$WORKFLOWS_DIR" \
  FIND_AV_PRECISION_CHECK_MARKER_FILE="$WORK_DIR/find-av-marker2.json" \
  bash "$LINKED_WT/scripts/check-find-av-precision-recorded.sh" < /dev/null 2>&1)"
set -e
assert_contains "$OUT" "systemMessage" "対: 共有側に記録が無ければ警告する"

echo "=== scenario 5: AIDD stats の確認は、worktree から動かしても共有の logs/ を読む ==="
# 共有側: このセッションの Workflow の形跡あり・stats 無し（警告すべき）。
# おとり: Workflow でないイベントだけ（こちらを読むと、呼び忘れがあっても黙る）
printf '{"timestamp":"%s","hookEvent":"SubagentStop","sessionId":"%s","agentId":"a1","agentTranscriptPath":"/home/u/.claude/projects/p/s/subagents/workflows/wf_abc123/agent-a1.jsonl"}\n' \
  "$SESSION_START_ISO" "$SESSION" > "$MAIN_REPO/logs/subagent-skeleton.jsonl"
printf '{"timestamp":"%s","hookEvent":"SubagentStop","sessionId":"%s","agentId":"a2","agentTranscriptPath":"/home/u/.claude/projects/p/s/subagents/agent-a2.jsonl"}\n' \
  "$SESSION_START_ISO" "$SESSION" > "$LINKED_WT/logs/subagent-skeleton.jsonl"
mkdir -p "$WORK_DIR/stats"
set +e
OUT="$(env -u AIDD_LOG_DIR -u AIDD_STATS_CHECK_SKELETON_LOG \
  CLAUDE_PROJECT_DIR="$LINKED_WT" \
  AIDD_STATS_CHECK_SESSION_ID="$SESSION" \
  AIDD_STATS_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
  AIDD_STATS_CHECK_STATS_DIR="$WORK_DIR/stats" \
  AIDD_STATS_CHECK_MARKER_FILE="$WORK_DIR/stats-marker.json" \
  bash "$LINKED_WT/scripts/check-aidd-stats-recorded.sh" < /dev/null 2>&1)"
CODE=$?
set -e
assert_eq "$CODE" "0" "exit 0（Stop hook は block しない）"
assert_contains "$OUT" "systemMessage" "共有側の Workflow の形跡を見つけて警告する（おとりを読むと黙る）"

echo "=== scenario 6: 実測用の一時ツールも、worktree から動かすと共有の logs/ へ書く ==="
printf '%s' '{"tasks":[]}' | (cd "$LINKED_WT" && env -u AIDD_LOG_DIR bash "$LINKED_WT/scripts/subagent-statusline-debug-collector.sh")
assert_eq "$([ -f "$MAIN_REPO/logs/subagent-statusline-debug.jsonl" ] && echo shared || echo missing)" "shared" "共有側に書かれる"
assert_eq "$([ -f "$LINKED_WT/logs/subagent-statusline-debug.jsonl" ] && echo local || echo none)" "none" "worktree 直下には書かれない"

echo "=== scenario 7: 骨格ログを TS の cwd 相対の既定に落とさない（ラッパーが共有側を渡す） ==="
WRAPPER="$SCRIPT_DIR/verify-agent-progress-transcript.sh"
if grep -qE -- '--skeleton-log-file "\$\(resolve_log_dir\)/subagent-skeleton\.jsonl"' "$WRAPPER"; then
  echo "  OK: ラッパーが --skeleton-log-file に共有側を渡している"
else
  echo "  NG: ラッパーが --skeleton-log-file を渡していない（TS 側の既定 logs/subagent-skeleton.jsonl は cwd 相対）"
  fail=1
fi
BASELINE="$SCRIPT_DIR/snapshot-agent-baseline.sh"
if grep -qF 'resolve_log_dir' "$BASELINE"; then
  echo "  OK: snapshot-agent-baseline.sh が resolve_log_dir を使う"
else
  echo "  NG: snapshot-agent-baseline.sh が resolve_log_dir を使っていない"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
