#!/usr/bin/env bash
set -euo pipefail

# AIDDワークフロー内の自然言語プロンプト（.claude/workflows/*.js）を、fixture SPEC.md →
# 実エージェント実行 → 期待status判定のassertで回帰テストするharness(issue #391)。
# 設計: docs/superpowers/specs/2026-07-15-workflow-prompt-eval-design.md
#
# 使い方: scripts/eval-workflow-prompts.sh <fixtureセット名>（例: db-impl）
#
# fixtureセットは scripts/eval-fixtures/<name>/ に以下の形式で置く:
#   manifest.json         { agentType, promptModule, promptFn, model, jsonSchema }
#   case-*/spec.md        fixtureのSPEC.md本文
#   case-*/expected.json  { "status": "pass"|"fail"|"blocked" }
#
# 各fixtureは本体リポジトリを汚さないよう、一時ディレクトリへのlocal clone上で実行する
# （fixtureによっては実際にsupabase/migrations/へファイルを書こうとするため）。
#
# サーキットブレーカー・hooks非継承・セッション非永続化は、verify-claims.shが2026-07-14に
# 経験したStop hook再帰暴走と同型の事故を未然に防ぐため、初回コミットから組み込んでいる。
#
# テスト容易性のため、以下を環境変数で上書き可能にしている（テストはscripts/eval-workflow-prompts.test.sh参照）:
#   EVAL_WORKFLOW_PROMPTS_REPO_DIR      - cloneの複製元リポジトリ（省略時はこのスクリプトの親）
#   EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR  - fixtureセットの置き場所（省略時は $REPO_DIR/scripts/eval-fixtures）
#   EVAL_WORKFLOW_PROMPTS_LOCK_DIR      - サーキットブレーカー用ロック置き場
#   EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT - 同時実行を許すeval呼び出し数の上限（省略時は2）
#   EVAL_WORKFLOW_PROMPTS_TIMEOUT_SECONDS - 1fixtureあたりのタイムアウト秒数（省略時は300。実装作業を伴うため verify-claims.sh より長め）
#   EVAL_WORKFLOW_PROMPTS_AGENT_CMD     - 実際の`claude -p`呼び出しの代わりに使うコマンド

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="${EVAL_WORKFLOW_PROMPTS_REPO_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
FIXTURES_ROOT="${EVAL_WORKFLOW_PROMPTS_FIXTURES_DIR:-$REPO_DIR/scripts/eval-fixtures}"
LOCK_DIR="${EVAL_WORKFLOW_PROMPTS_LOCK_DIR:-$REPO_DIR/.claude/.eval-lock}"
MAX_CONCURRENT="${EVAL_WORKFLOW_PROMPTS_MAX_CONCURRENT:-2}"
TIMEOUT_SECONDS="${EVAL_WORKFLOW_PROMPTS_TIMEOUT_SECONDS:-300}"

FIXTURE_SET="${1:-}"
if [ -z "$FIXTURE_SET" ]; then
  echo "usage: $0 <fixture-set-name>" >&2
  exit 1
fi

FIXTURE_SET_DIR="$FIXTURES_ROOT/$FIXTURE_SET"
MANIFEST_FILE="$FIXTURE_SET_DIR/manifest.json"
if [ ! -f "$MANIFEST_FILE" ]; then
  echo "eval-workflow-prompts: manifest not found: $MANIFEST_FILE" >&2
  exit 1
fi

AGENT_TYPE="$(jq -r '.agentType' "$MANIFEST_FILE")"
PROMPT_MODULE="$(jq -r '.promptModule' "$MANIFEST_FILE")"
PROMPT_FN="$(jq -r '.promptFn' "$MANIFEST_FILE")"
MODEL="$(jq -r '.model' "$MANIFEST_FILE")"
JSON_SCHEMA="$(jq -c '.jsonSchema' "$MANIFEST_FILE")"

mkdir -p "$LOCK_DIR"

# --- サーキットブレーカー: 同時実行中のeval呼び出し数が上限を超えたら中断する ---
# 死んだプロセスのロックエントリ(前回異常終了で残った分)を先に掃除する(verify-claims.shと同じパターン)。
for entry in "$LOCK_DIR"/*; do
  [ -e "$entry" ] || continue
  entry_pid="$(basename "$entry")"
  if ! kill -0 "$entry_pid" 2>/dev/null; then
    rmdir "$entry" 2>/dev/null || true
  fi
done
CURRENT_CONCURRENT="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CURRENT_CONCURRENT" -ge "$MAX_CONCURRENT" ]; then
  echo "eval-workflow-prompts: 同時実行数が上限(${MAX_CONCURRENT})に達しているため中断しました（サーキットブレーカー）。しばらく待って再実行してください。" >&2
  exit 1
fi
LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

run_agent() {
  local prompt="$1"
  if [ -n "${EVAL_WORKFLOW_PROMPTS_AGENT_CMD:-}" ]; then
    printf '%s' "$prompt" | eval "$EVAL_WORKFLOW_PROMPTS_AGENT_CMD"
    return $?
  fi
  # --setting-sources ""はhook再帰防止(verify-claims.shが2026-07-14に経験した再帰暴走と同型の
  # 事故を防ぐ)に必要だが、これを付けると.claude/agents/*.mdのファイル探索によるカスタムagent型
  # 解決も同時に無効化されてしまい、`--agent implementer`が
  # `--agent 'implementer' not found`で失敗する(issue #391で実機確認)。--setting-sourcesは
  # 弱めず、代わりにagent定義自体を--agentsフラグで明示的に注入することで解決する。
  # 呼び出し時点のcwdは常にfixture用clone($CLONE_DIR/repo)配下になっている
  # (run_agent_with_timeoutの呼び出し元 `cd "$CLONE_DIR/repo" && run_agent_with_timeout ...` 参照)。
  local agent_md="$PWD/.claude/agents/${AGENT_TYPE}.md"
  local agents_json
  agents_json="$(node "$SCRIPT_DIR/lib/build-eval-agent-json.mjs" "$agent_md" "$AGENT_TYPE")"
  printf '%s' "$prompt" | claude -p --agent "$AGENT_TYPE" --model "$MODEL" \
    --json-schema "$JSON_SCHEMA" \
    --agents "$agents_json" \
    --setting-sources "" \
    --no-session-persistence
}

# ポータブルなタイムアウト実装（verify-claims.shと同じパターン）
run_agent_with_timeout() {
  local out_file
  out_file="$(mktemp)"
  # run_agentはclaude -p(実際にファイルを書き込みうるagentType)をさらにforkする。
  # verify-claims.shのrun_verifier_with_timeoutは読み取り専用ツールしか使わないagentが
  # 前提のため単一PID killで安全だったが、それをそのまま踏襲すると、タイムアウト時にラッパー
  # サブシェルだけ死んでclaude本体が孤児化し、$CLONE_DIRをrm -rfした後もファイル書き込みを
  # 続ける事故になりうる。setsidはmacOS(この開発環境)に存在しないため、bashのjob control
  # (`set -m`)でバックグラウンドジョブを専用プロセスグループのリーダーにし、タイムアウト時は
  # プロセスグループごとkillする。この関数は呼び出し元で`$(...)`(サブシェル)越しに呼ばれる
  # ため、ここでのset -m/set +mはそのサブシェル内に閉じ、呼び出し元スクリプト全体には影響しない。
  set -m
  ( run_agent "$1" > "$out_file" 2>/dev/null; echo $? > "${out_file}.exit" ) &
  local pid=$!
  set +m
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      # プロセスグループ全体をkill。"-$pid"が使えない環境向けに単一PID killへフォールバックする。
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
PASS_COUNT=0
FAIL_LINES=""

for case_dir in "$FIXTURE_SET_DIR"/case-*/; do
  [ -d "$case_dir" ] || continue
  case_name="$(basename "$case_dir")"
  spec_file="${case_dir}spec.md"
  expected_file="${case_dir}expected.json"
  if [ ! -f "$spec_file" ] || [ ! -f "$expected_file" ]; then
    echo "eval-workflow-prompts: $case_name はspec.mdまたはexpected.jsonが無いためスキップします" >&2
    continue
  fi
  TOTAL=$((TOTAL + 1))
  EXPECTED_STATUS="$(jq -r '.status' "$expected_file")"

  CLONE_DIR="$(mktemp -d)"
  # git clone/プロンプト構築の失敗を`set -e`で全体abortさせず、当該fixtureのNGとして
  # 記録した上で次のfixtureへ進む(エージェント呼び出し失敗・status不一致と同じ扱いに揃える)。
  # ガードしないと1fixtureの事故(cloneミス等)で残り全fixtureの結果が失われ、かつ
  # $CLONE_DIRがrm -rfされずリークする。
  CLONE_EXIT=0
  git clone --quiet --depth 1 "file://$REPO_DIR" "$CLONE_DIR/repo" || CLONE_EXIT=$?
  if [ "$CLONE_EXIT" -ne 0 ]; then
    rm -rf "$CLONE_DIR"
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: リポジトリのcloneに失敗しました(exit=$CLONE_EXIT)"
    continue
  fi
  cp "$spec_file" "$CLONE_DIR/repo/SPEC.md"

  BUILD_EXIT=0
  PROMPT="$(node "$SCRIPT_DIR/lib/build-eval-prompt.mjs" "$CLONE_DIR/repo/$PROMPT_MODULE" "$PROMPT_FN" "SPEC.md")" || BUILD_EXIT=$?
  if [ "$BUILD_EXIT" -ne 0 ]; then
    rm -rf "$CLONE_DIR"
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: プロンプトの構築に失敗しました(exit=$BUILD_EXIT)"
    continue
  fi

  AGENT_EXIT=0
  AGENT_OUTPUT="$(cd "$CLONE_DIR/repo" && run_agent_with_timeout "$PROMPT")" || AGENT_EXIT=$?
  rm -rf "$CLONE_DIR"

  if [ "$AGENT_EXIT" -ne 0 ]; then
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: エージェント実行が失敗しました(exit=$AGENT_EXIT)"
    continue
  fi

  ACTUAL_STATUS="$(printf '%s' "$AGENT_OUTPUT" | jq -r '.status' 2>/dev/null || echo "")"
  if [ "$ACTUAL_STATUS" = "$EXPECTED_STATUS" ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
    echo "[$case_name] OK: status=$ACTUAL_STATUS (期待通り)"
  else
    FAIL_LINES="$FAIL_LINES
- [$case_name] NG: status=$ACTUAL_STATUS (期待値=$EXPECTED_STATUS)"
  fi
done

# case-*/が1件もマッチしなかった場合(非nullglobのbashでは`for`が展開されない
# 文字列そのままで1回だけ回るため`[ -d "$case_dir" ]`で弾かれTOTALが0のまま残る)、
# fixtureセット名の誤り等の設定ミスを「0/0件合格」という誤ったexit 0で握りつぶさない。
if [ "$TOTAL" -eq 0 ]; then
  echo "eval-workflow-prompts: $FIXTURE_SET_DIR に case-*/ ディレクトリが1件も見つかりませんでした（spec.md/expected.jsonが揃っているケースが無いか、fixtureセット名が間違っている可能性があります）" >&2
  exit 1
fi

echo ""
echo "=== eval-workflow-prompts: $FIXTURE_SET ==="
echo "$PASS_COUNT / $TOTAL 件 合格"
if [ -n "$FAIL_LINES" ]; then
  echo "$FAIL_LINES"
  exit 1
fi
exit 0
