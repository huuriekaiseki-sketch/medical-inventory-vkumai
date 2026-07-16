#!/usr/bin/env bash
set -euo pipefail

# issue #431: sweep-*エージェントの見落とし率(recall)を測る、既知欠陥埋め込みfixtureの
# 回帰テストharness。issue #391のeval基盤(scripts/eval-workflow-prompts.sh)と同じ
# load-bearing workaround（--setting-sources "" + --agents注入、git clone隔離、
# --no-session-persistence、同時実行数の上限によるサーキットブレーカー）をそのまま
# 再利用する。ただしdb-implのように単一のSPEC.mdをコピーするだけでは足りず、
# fixtureごとに任意のファイルツリー(files/)をclone先へ上書き配置する点が異なるため、
# eval-workflow-prompts.shを直接改修せず、並立するスクリプトとして新設した。
#
# 判定方法: sweep出力(detail)に対し、期待ファイルパスの部分文字列と期待キーワードの
# いずれか1つが両方含まれていればヒット(見落としなし)とする決定的判定。LLM judgeは
# 使わない(判定器自体が非決定になると回帰テストの意味が薄れるため。issue本文の設計判断)。
#
# 使い方: scripts/eval-sweep-recall.sh <layer>（例: sweep-ui）
#
# 環境変数（テスト容易性のため上書き可能。scripts/eval-workflow-prompts.shと同じパターン）:
#   EVAL_SWEEP_RECALL_REPO_DIR      - cloneの複製元リポジトリ（省略時はこのスクリプトの親）
#   EVAL_SWEEP_RECALL_FIXTURES_DIR  - fixtureセットの置き場所（省略時は $REPO_DIR/scripts/eval-fixtures）
#   EVAL_SWEEP_RECALL_LOCK_DIR      - サーキットブレーカー用ロック置き場
#   EVAL_SWEEP_RECALL_MAX_CONCURRENT - 同時実行を許すeval呼び出し数の上限（省略時は2）
#   EVAL_SWEEP_RECALL_TIMEOUT_SECONDS - 1caseあたりのタイムアウト秒数（省略時は300）
#   EVAL_SWEEP_RECALL_AGENT_CMD     - 実際の`claude -p`呼び出しの代わりに使うコマンド

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${EVAL_SWEEP_RECALL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FIXTURES_ROOT="${EVAL_SWEEP_RECALL_FIXTURES_DIR:-$REPO_DIR/scripts/eval-fixtures}"
LOCK_DIR="${EVAL_SWEEP_RECALL_LOCK_DIR:-$REPO_DIR/.claude/.eval-sweep-recall-lock}"
MAX_CONCURRENT="${EVAL_SWEEP_RECALL_MAX_CONCURRENT:-2}"
TIMEOUT_SECONDS="${EVAL_SWEEP_RECALL_TIMEOUT_SECONDS:-300}"

LAYER="${1:-}"
if [ -z "$LAYER" ]; then
  echo "usage: $0 <layer>（例: sweep-ui）" >&2
  exit 1
fi

FIXTURE_SET_DIR="$FIXTURES_ROOT/$LAYER"
MANIFEST_FILE="$FIXTURE_SET_DIR/manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "eval-sweep-recall: manifest not found: $MANIFEST_FILE" >&2
  exit 1
fi

AGENT_TYPE="$(jq -r '.agentType' "$MANIFEST_FILE")"
MODEL="$(jq -r '.model' "$MANIFEST_FILE")"

# docs/agents/agent-result-schema.md参照。aidd-phase1.jsのAGENT_RESULT_SCHEMAと同一。
JSON_SCHEMA='{"type":"object","properties":{"status":{"type":"string","enum":["pass","blocked"]},"detail":{"type":"string"}},"required":["status","detail"]}'

mkdir -p "$LOCK_DIR"

# --- サーキットブレーカー: eval-workflow-prompts.shと同じパターン ---
for entry in "$LOCK_DIR"/*; do
  [ -e "$entry" ] || continue
  entry_pid="$(basename "$entry")"
  if ! kill -0 "$entry_pid" 2>/dev/null; then
    rmdir "$entry" 2>/dev/null || true
  fi
done
CURRENT_CONCURRENT="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CURRENT_CONCURRENT" -ge "$MAX_CONCURRENT" ]; then
  echo "eval-sweep-recall: 同時実行数が上限(${MAX_CONCURRENT})に達しているため中断しました（サーキットブレーカー）。しばらく待って再実行してください。" >&2
  exit 1
fi
LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

run_agent() {
  local prompt="$1"
  if [ -n "${EVAL_SWEEP_RECALL_AGENT_CMD:-}" ]; then
    printf '%s' "$prompt" | eval "$EVAL_SWEEP_RECALL_AGENT_CMD"
    return $?
  fi
  # scripts/eval-workflow-prompts.shと同じ理由でこの組み合わせが必要
  # (docs/agents/common.md「ツール制約回避のload-bearing workaround棚卸し」参照)。
  local agent_md="$PWD/.claude/agents/${AGENT_TYPE}.md"
  local agents_json
  agents_json="$(node "$SCRIPT_DIR/lib/build-eval-agent-json.mjs" "$agent_md" "$AGENT_TYPE")"
  printf '%s' "$prompt" | claude -p --agent "$AGENT_TYPE" --model "$MODEL" \
    --json-schema "$JSON_SCHEMA" \
    --agents "$agents_json" \
    --setting-sources "" \
    --no-session-persistence
}

run_agent_with_timeout() {
  local out_file
  out_file="$(mktemp)"
  set -m
  ( run_agent "$1" > "$out_file" 2>/dev/null; echo $? > "${out_file}.exit" ) &
  local pid=$!
  set +m
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      cat "$out_file" 2>/dev/null || true
      rm -f "$out_file" "${out_file}.exit"
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || true
  local status
  status="$(cat "${out_file}.exit" 2>/dev/null || echo 1)"
  cat "$out_file"
  rm -f "$out_file" "${out_file}.exit"
  return "$status"
}

TOTAL=0
HIT_COUNT=0
MISS_LINES=""

for case_dir in "$FIXTURE_SET_DIR"/case-*/; do
  [ -d "$case_dir" ] || continue
  case_name="$(basename "$case_dir")"
  files_dir="${case_dir}files"
  expected_file="${case_dir}expected.json"
  if [ ! -d "$files_dir" ] || [ ! -f "$expected_file" ]; then
    echo "eval-sweep-recall: $case_name はfiles/またはexpected.jsonが無いためスキップします" >&2
    continue
  fi
  TOTAL=$((TOTAL + 1))
  EXPECTED_PATH="$(jq -r '.expectedFilePathContains' "$expected_file")"

  CLONE_DIR="$(mktemp -d)"
  CLONE_EXIT=0
  git clone --quiet --depth 1 "file://$REPO_DIR" "$CLONE_DIR/repo" || CLONE_EXIT=$?
  if [ "$CLONE_EXIT" -ne 0 ]; then
    rm -rf "$CLONE_DIR"
    MISS_LINES="$MISS_LINES
- [$case_name] NG: リポジトリのcloneに失敗しました(exit=$CLONE_EXIT)"
    continue
  fi
  cp -r "$files_dir"/. "$CLONE_DIR/repo/"

  BUILD_EXIT=0
  PROMPT="$(node "$SCRIPT_DIR/lib/build-eval-prompt.mjs" "$CLONE_DIR/repo/.claude/workflows/lib/prompts/sweep.js" buildSweepPrompt "現在のコードベース全体の調査")" || BUILD_EXIT=$?
  if [ "$BUILD_EXIT" -ne 0 ]; then
    rm -rf "$CLONE_DIR"
    MISS_LINES="$MISS_LINES
- [$case_name] NG: プロンプトの構築に失敗しました(exit=$BUILD_EXIT)"
    continue
  fi

  AGENT_EXIT=0
  AGENT_OUTPUT="$(cd "$CLONE_DIR/repo" && run_agent_with_timeout "$PROMPT")" || AGENT_EXIT=$?
  rm -rf "$CLONE_DIR"

  if [ "$AGENT_EXIT" -ne 0 ]; then
    MISS_LINES="$MISS_LINES
- [$case_name] NG: エージェント実行が失敗しました(exit=$AGENT_EXIT)"
    continue
  fi

  DETAIL_FILE="$(mktemp)"
  printf '%s' "$AGENT_OUTPUT" | jq -r '.detail // ""' > "$DETAIL_FILE" 2>/dev/null || echo -n "" > "$DETAIL_FILE"
  IS_HIT="$(EXPECTED_FILE="$expected_file" DETAIL_FILE="$DETAIL_FILE" python3 "$SCRIPT_DIR/lib/judge-sweep-recall.py")"
  rm -f "$DETAIL_FILE"

  if [ "$IS_HIT" = "true" ]; then
    HIT_COUNT=$((HIT_COUNT + 1))
    echo "[$case_name] HIT: 期待ファイル($EXPECTED_PATH)とキーワードの両方を検出"
  else
    MISS_LINES="$MISS_LINES
- [$case_name] MISS: 期待ファイル($EXPECTED_PATH)またはキーワードを検出できず"
  fi
done

if [ "$TOTAL" -eq 0 ]; then
  echo "eval-sweep-recall: $FIXTURE_SET_DIR に case-*/ ディレクトリが1件も見つかりませんでした" >&2
  exit 1
fi

echo ""
echo "=== eval-sweep-recall: $LAYER ==="
echo "recall: $HIT_COUNT / $TOTAL"
if [ -n "$MISS_LINES" ]; then
  echo "$MISS_LINES"
  exit 1
fi
exit 0
