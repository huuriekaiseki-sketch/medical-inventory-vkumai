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
# 実行が最後まで完了すると(hit/miss問わず)、$REPO_DIR/docs/agents/eval-runs.jsonl に
# 実行痕跡(日時・layer名・合否件数)を1行追記する(issue #496。eval-workflow-prompts.shと同型)。
#
# 使い方: scripts/eval-sweep-recall.sh <layer>（例: sweep-ui）
#
# 環境変数（テスト容易性のため上書き可能。scripts/eval-workflow-prompts.shと同じパターン）:
#   EVAL_SWEEP_RECALL_REPO_DIR      - cloneの複製元リポジトリ（省略時はこのスクリプトの親）
#   EVAL_SWEEP_RECALL_FIXTURES_DIR  - fixtureセットの置き場所（省略時は $REPO_DIR/scripts/eval-fixtures）
#   EVAL_SWEEP_RECALL_LOCK_DIR      - サーキットブレーカー用ロック置き場
#   EVAL_SWEEP_RECALL_MAX_CONCURRENT - 同時実行を許すeval呼び出し数の上限（省略時は2）
#   EVAL_SWEEP_RECALL_TIMEOUT_SECONDS - 1caseあたりのタイムアウト秒数（省略時は900。sweep-dataは
#     全リポジトリのAPIルート・data層を走査するため実測で数分〜30分近くかかることがある）
#   EVAL_SWEEP_RECALL_AGENT_CMD     - 実際の`claude -p`呼び出しの代わりに使うコマンド
#   EVAL_SWEEP_RECALL_MODEL     - manifest のモデルを上書きする（同じ fixture を別モデルで測る）
#   EVAL_SWEEP_RECALL_DEBUG_DIR     - 指定すると各caseの生出力(JSON)を<case名>.jsonとして保存する

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${EVAL_SWEEP_RECALL_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FIXTURES_ROOT="${EVAL_SWEEP_RECALL_FIXTURES_DIR:-$REPO_DIR/scripts/eval-fixtures}"
LOCK_DIR="${EVAL_SWEEP_RECALL_LOCK_DIR:-$REPO_DIR/.claude/.eval-sweep-recall-lock}"
MAX_CONCURRENT="${EVAL_SWEEP_RECALL_MAX_CONCURRENT:-2}"
TIMEOUT_SECONDS="${EVAL_SWEEP_RECALL_TIMEOUT_SECONDS:-900}"

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
# モデルは manifest の値が既定。**実行時に差し替えられる**（2026-09-10）——
# 「指示が悪いのか、モデルの容量が足りないのか」を分けて測るための口。
# 差し替えた回は記録の `model` も変わるので、条件が違う回として扱われ混ざらない。
MODEL="${EVAL_SWEEP_RECALL_MODEL:-$(jq -r '.model' "$MANIFEST_FILE")}"

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
  # --permission-mode bypassPermissions: issue #401で実機確認された対策。呼び出し先は
  # 必ず使い捨てのgit clone上であり実リポジトリは汚さないため全権限自動承認を許容する。
  local agent_md="$PWD/.claude/agents/${AGENT_TYPE}.md"
  local agents_json
  agents_json="$(node "$SCRIPT_DIR/lib/build-eval-agent-json.mjs" "$agent_md" "$AGENT_TYPE")"
  # --output-format json: 使用量（トークン数・費用）を返させる（2026-09-10、設計提案 3「費用」）。
  # --json-schema と併用できることは実測済み。包みは scripts/lib/agent-output.mjs が剥がす
  printf '%s' "$prompt" | claude -p --agent "$AGENT_TYPE" --model "$MODEL" \
    --json-schema "$JSON_SCHEMA" \
    --agents "$agents_json" \
    --setting-sources "" \
    --permission-mode bypassPermissions \
    --output-format json \
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

# 記録と使用量の足し上げは共通（scripts/lib/record-eval-run.sh）。
# **ループより前に読み込む**——accumulate_usage をループの中で呼ぶため
# shellcheck source=lib/record-eval-run.sh
source "$SCRIPT_DIR/lib/record-eval-run.sh"

# 所要時間を測る起点（設計提案 3「再現性と費用」のうち時間の側）
RUN_STARTED_AT="$(date +%s)"
# 実コードへの指摘の多さ（2026-09-10）。読めなかった回は 0 と混ぜず別に数える
FINDINGS_REPORTED=0
FINDINGS_SAMPLES=0
FINDINGS_UNREADABLE=0
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

  if [ -n "${EVAL_SWEEP_RECALL_DEBUG_DIR:-}" ]; then
    mkdir -p "$EVAL_SWEEP_RECALL_DEBUG_DIR"
    printf '%s' "$AGENT_OUTPUT" > "$EVAL_SWEEP_RECALL_DEBUG_DIR/${case_name}.json"
  fi

  if [ "$AGENT_EXIT" -ne 0 ]; then
    MISS_LINES="$MISS_LINES
- [$case_name] NG: エージェント実行が失敗しました(exit=$AGENT_EXIT)"
    continue
  fi

  DETAIL_FILE="$(mktemp)"
  # WHY(issue #731): --json-schema を渡しても、モデル（特に haiku）が JSON でなく素のテキストで返す
  #      ことがある。その場合 jq が失敗して detail が空になり、エージェントが欠陥を正しく報告して
  #      いても MISS になっていた（2026-09-05 実測: 生出力に期待パスとキーワードの両方があるのに 0/1）。
  #      JSON として読めなければ生出力全体を判定対象にする（判定は部分文字列一致なので過検出は
  #      増えない。status の取得は諦める）
  # `claude -p --output-format json` の包みを剥がす。**包みが無い（モック）出力もそのまま通る**
  AGENT_PAYLOAD="$(printf '%s' "$AGENT_OUTPUT" | node "$SCRIPT_DIR/lib/agent-output.mjs" --payload 2>/dev/null || printf '%s' "$AGENT_OUTPUT")"
  # 使用量を足し上げる（設計提案 3「費用」）
  USAGE_JSON="$(printf '%s' "$AGENT_OUTPUT" | node "$SCRIPT_DIR/lib/agent-output.mjs" --usage 2>/dev/null || echo '{}')"
  accumulate_usage "$USAGE_JSON"

  if ! printf '%s' "$AGENT_PAYLOAD" | jq -r '.detail // ""' > "$DETAIL_FILE" 2>/dev/null; then
    printf '%s' "$AGENT_PAYLOAD" > "$DETAIL_FILE"
    echo "[$case_name] 注意: エージェント出力が JSON ではないため生出力全体を判定対象にしました" >&2
  fi
  IS_HIT="$(EXPECTED_FILE="$expected_file" DETAIL_FILE="$DETAIL_FILE" python3 "$SCRIPT_DIR/lib/judge-sweep-recall.py")"
  # 実コードへの指摘の多さを追う（2026-09-10）。**本物か誤りかは分けない**——
  # 分けるのは人の仕事で、ここで測れるのは「増えた／減った」だけ。
  # 読めなかった回（-1）は 0 と混ぜず、別に数える。
  CASE_FINDINGS="$(DETAIL_FILE="$DETAIL_FILE" python3 "$SCRIPT_DIR/lib/judge-sweep-recall.py" --count 2>/dev/null || echo -1)"
  if [ "$CASE_FINDINGS" -ge 0 ] 2>/dev/null; then
    FINDINGS_REPORTED=$((FINDINGS_REPORTED + CASE_FINDINGS))
    FINDINGS_SAMPLES=$((FINDINGS_SAMPLES + 1))
  else
    FINDINGS_UNREADABLE=$((FINDINGS_UNREADABLE + 1))
  fi
  rm -f "$DETAIL_FILE"

  # 陰性対照（欠陥の無い fixture）は逆向きに採点する。HIT/MISS の文言もそれに合わせる
  # （2026-09-10・レビュー指摘 R11。陽性だけを測ると「全部に指摘を出す」エージェントが満点になる）
  EXPECT_NO_FINDING="$(jq -r '.expectNoFinding // false' "$expected_file")"
  if [ "$IS_HIT" = "true" ]; then
    HIT_COUNT=$((HIT_COUNT + 1))
    if [ "$EXPECT_NO_FINDING" = "true" ]; then
      echo "[${case_name}] HIT（陰性対照）: 欠陥の無いコードに指摘を出さなかった"
    else
      echo "[${case_name}] HIT: 期待ファイル(${EXPECTED_PATH})とキーワードの両方を、指摘として報告した"
    fi
  elif [ "$EXPECT_NO_FINDING" = "true" ]; then
    MISS_LINES="$MISS_LINES
- [${case_name}] MISS（陰性対照）: 欠陥の無いコードに指摘を出した（過検出）"
  else
    MISS_LINES="$MISS_LINES
- [${case_name}] MISS: 期待ファイル(${EXPECTED_PATH})かキーワードが無い、または「指摘なし」と報告した"
  fi
done

if [ "$TOTAL" -eq 0 ]; then
  echo "eval-sweep-recall: $FIXTURE_SET_DIR に case-*/ ディレクトリが1件も見つかりませんでした" >&2
  exit 1
fi

echo ""
echo "=== eval-sweep-recall: $LAYER ==="
echo "recall: $HIT_COUNT / $TOTAL"

# 条件（木のハッシュ・モデル）・所要時間・費用も一緒に残す
# ——**同じ条件の回どうしでしかばらつきは比べられない**（設計提案 3）
EVAL_RUNS_REPO_DIR="$REPO_DIR" \
EVAL_FINDINGS_REPORTED="$FINDINGS_REPORTED" \
EVAL_FINDINGS_SAMPLES="$FINDINGS_SAMPLES" \
EVAL_FINDINGS_UNREADABLE="$FINDINGS_UNREADABLE" \
record_eval_run \
  "eval-sweep-recall" "$LAYER" "$HIT_COUNT" "$TOTAL" "$RUN_STARTED_AT" "$MODEL"

if [ -n "$MISS_LINES" ]; then
  echo "$MISS_LINES"
  exit 1
fi
exit 0
