#!/usr/bin/env bash
set -euo pipefail

# .claude/workflows/aidd-phase2.js の db-impl プロンプト（Contract + DB フェーズ）に対する
# 回帰テスト(eval)。fixture SPEC(3種)を db-impl プロンプトに読ませ、期待するstatus判定
# （①DB変更あり→pass ②「該当なし」明記→pass ③DB言及なし→blocked）と一致するかを機械的に
# 検証する。issue #389（db-implがDB変更不要ケースを一律blocked判定していた）の再発防止。
# 設計: docs/agents/common.md「検知手段のないルールの棚卸し（issue #339）」/
#       verify-claims.sh のサーキットブレーカー構成を踏襲（issue #391）。
#
# 実行: bash scripts/eval-workflow-prompts.sh
#
# WHY: db-implプロンプトは .claude/workflows/aidd-phase2.js 内のテンプレートリテラルとして
# 定義されており、Workflow DSLはrequire不可のためこのスクリプトから直接importできない。
# .claude/workflows/lib/manifest-check.js と同じ制約・同じ運用方針を取る: プロンプト文言を
# 変更した場合は下記 db_impl_prompt() も手動で追従させること（自動では同期されない）。
#
# 環境変数（テスト容易性のため上書き可能。scripts/eval-workflow-prompts.test.sh 参照）:
#   EVAL_WORKFLOW_MODEL       - 評価に使うモデル（省略時は claude-sonnet-5。実際のaidd-phase2.js
#                               db-implはimplementer agentTypeでmodel未指定=セッション既定モデル
#                               継承のため、verify-claims.shのhaikuより実運用に近いsonnetを既定
#                               にしている。実測でhaikuは「DB言及なし」ケースをpassと誤判定する
#                               ことがあり、安価だが本evalの検出精度としては不適だった）
#   EVAL_WORKFLOW_TIMEOUT_SECONDS - claude -p サブプロセスのタイムアウト秒数（省略時は180。
#                               「DB言及なし」の曖昧なfixtureは探索に時間がかかり120秒では
#                               タイムアウトすることが実測で確認された）
#   EVAL_WORKFLOW_VERIFIER_CMD - 実際の`claude -p`呼び出しの代わりに使うコマンド（標準入力で
#                                プロンプトを受け取り、{"status":...,"detail":...}のJSONを返すこと）
#   EVAL_WORKFLOW_LOCK_DIR     - サーキットブレーカー用ロック置き場（省略時は .claude/.eval-workflow-lock）
#   EVAL_WORKFLOW_MAX_CONCURRENT - 同時実行を許すeval評価プロセス数の上限（省略時は2）
#   EVAL_WORKFLOW_FIXTURES_DIR - fixture SPECの配置先（省略時は scripts/fixtures/eval-workflow-prompts）
#   EVAL_WORKFLOW_WORKDIR      - 各fixture実行用の隔離作業ディレクトリの親（省略時はmktemp）
#   EVAL_WORKFLOW_DEBUG_DIR    - 指定すると各fixtureの生出力を<fixture名>.raw.txtとして保存する
#                               （JSON解析失敗時の原因調査用）

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

MODEL="${EVAL_WORKFLOW_MODEL:-claude-sonnet-5}"
TIMEOUT_SECONDS="${EVAL_WORKFLOW_TIMEOUT_SECONDS:-180}"
LOCK_DIR="${EVAL_WORKFLOW_LOCK_DIR:-.claude/.eval-workflow-lock}"
MAX_CONCURRENT="${EVAL_WORKFLOW_MAX_CONCURRENT:-2}"
FIXTURES_DIR="${EVAL_WORKFLOW_FIXTURES_DIR:-scripts/fixtures/eval-workflow-prompts}"

mkdir -p "$LOCK_DIR"

# fixture名:期待status（.claude/workflows/aidd-phase2.js AGENT_RESULT_SCHEMAのstatusと同じ語彙）
FIXTURES=(
  "db-change.md:pass"
  "no-db-change-explicit.md:pass"
  "db-silent.md:blocked"
)

# .claude/workflows/aidd-phase2.js の db-impl プロンプト（Contract + DBフェーズ、agent()呼び出し
# 1引数目）を手動で複製したもの。${SPEC_PATH}のみプレースホルダとして残している。
db_impl_prompt() {
  local spec_path="$1"
  cat <<PROMPT_EOF
まず ${spec_path} を Read ツールで読んでください。
Part 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。
Part 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。

## 出力形式
status と detail を返すこと。
- pass: マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した
- fail: マイグレーションを試みたがエラー・矛盾がある
- blocked: SPEC.mdが存在しない、またはPart2にDB変更の要否自体を判断できる記載が無い

failの場合はfindings配列（{ severity: critical/important/minor, description }）で指摘ごとに
重大度を明記すること。findings全件がminorならこのゲートは通過扱いになる。
findingsを省略した場合、またはcritical/important指摘が1件でもあれば差し戻し対象になる
（severity不明・欠損はcritical扱い。fail-open防止）。

# 出力形式（最終）
以下のJSON形式のみを出力してください。マークダウンのコードフェンスや説明文は付けないこと。
{"status": "pass" | "fail" | "blocked", "detail": "...", "findings": [{"severity": "critical" | "important" | "minor", "description": "..."}]}
PROMPT_EOF
}

run_verifier() {
  local prompt="$1" cwd="$2"
  # WHY: モック(EVAL_WORKFLOW_VERIFIER_CMD)差し替え時も実行(claude -p)時も、必ず隔離作業
  # ディレクトリ内でコマンドを実行する。cdを実行claude -p側にしか掛けていないと、モックが
  # cwd起点のファイル(例: SPEC.md)を読む実装だった場合にリポジトリ直下の同名ファイルを誤って
  # 読んでしまう(fixtureの内容ではなく実リポジトリの状態に依存した誤判定になる)。
  (
    cd "$cwd"
    if [ -n "${EVAL_WORKFLOW_VERIFIER_CMD:-}" ]; then
      printf '%s' "$prompt" | eval "$EVAL_WORKFLOW_VERIFIER_CMD"
      exit $?
    fi
    # verify-claims.shと同じ理由でsettings.json非継承・非永続化を必須にする
    # （hooks継承による自己再帰暴走の防止。2026-07-14の実害を踏まえた既存パターンの踏襲）。
    # 隔離作業ディレクトリ内でのみ Read/Write/Bash(mkdir/date/shasum) を許可し、実リポジトリを汚さない。
    printf '%s' "$prompt" | claude -p --model "$MODEL" \
      --allowedTools "Read,Write,Bash(mkdir *),Bash(date *),Bash(shasum *)" \
      --setting-sources "" \
      --no-session-persistence
  )
}

run_verifier_with_timeout() {
  local prompt="$1" cwd="$2"
  local out_file
  out_file="$(mktemp)"
  ( run_verifier "$prompt" "$cwd" > "$out_file" 2>/dev/null; echo $? > "${out_file}.exit" ) &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$TIMEOUT_SECONDS" ]; then
      kill "$pid" 2>/dev/null || true
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

# --- サーキットブレーカー: verify-claims.shと同型（同時実行数上限でfail-open） ---
for entry in "$LOCK_DIR"/*; do
  [ -e "$entry" ] || continue
  entry_pid="$(basename "$entry")"
  if ! kill -0 "$entry_pid" 2>/dev/null; then
    rmdir "$entry" 2>/dev/null || true
  fi
done

CURRENT_CONCURRENT="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CURRENT_CONCURRENT" -ge "$MAX_CONCURRENT" ]; then
  echo "eval-workflow-prompts: 同時実行数が上限(${MAX_CONCURRENT})に達しているため、今回の実行をスキップしました(サーキットブレーカー)。" >&2
  exit 0
fi

LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

FAIL=0
for entry in "${FIXTURES[@]}"; do
  FIXTURE_FILE="${entry%%:*}"
  EXPECTED_STATUS="${entry##*:}"
  FIXTURE_PATH="$REPO_DIR/$FIXTURES_DIR/$FIXTURE_FILE"

  if [ ! -f "$FIXTURE_PATH" ]; then
    echo "NG: $FIXTURE_FILE - fixtureファイルが見つかりません: $FIXTURE_PATH"
    FAIL=1
    continue
  fi

  ISOLATED_DIR="${EVAL_WORKFLOW_WORKDIR:-$(mktemp -d)}/$FIXTURE_FILE"
  mkdir -p "$ISOLATED_DIR/supabase/migrations"
  cp "$FIXTURE_PATH" "$ISOLATED_DIR/SPEC.md"

  PROMPT="$(db_impl_prompt "SPEC.md")"

  EXIT_CODE=0
  OUTPUT="$(run_verifier_with_timeout "$PROMPT" "$ISOLATED_DIR")" || EXIT_CODE=$?
  if [ -n "${EVAL_WORKFLOW_DEBUG_DIR:-}" ]; then
    mkdir -p "$EVAL_WORKFLOW_DEBUG_DIR"
    printf '%s' "$OUTPUT" > "$EVAL_WORKFLOW_DEBUG_DIR/$FIXTURE_FILE.raw.txt"
  fi

  if [ "$EXIT_CODE" -ne 0 ]; then
    echo "NG: $FIXTURE_FILE - 評価プロセスの実行に失敗しました(exit=${EXIT_CODE})"
    FAIL=1
    continue
  fi

  # WHY: プロンプトで「JSON形式のみ・説明文やコードフェンスを付けないこと」と指示しても、
  # モデルが説明文を前置きしたりコードフェンスで囲んだりすることがある(実測確認: 「該当なし」
  # 明記fixtureで説明文+改行+単一行JSONという実際の出力パターンを確認済み)。このスクリプトは
  # verify-claims.shと違いschema強制機能(Workflow DSLのagent()内部実装)を持たないCLI直接
  # 呼び出しのため、出力の各行を末尾から順にjqでパースし、`.status`キーを持つ有効なJSON
  # オブジェクトとして解釈できた最後の行をJSON本体として採用する(前置きの説明文・コード
  # フェンスの影響を受けない。JSON自体が複数行に整形された場合は救えない既知の限界)。
  JSON_BODY=""
  while IFS= read -r line; do
    if printf '%s' "$line" | jq -e 'has("status")' >/dev/null 2>&1; then
      JSON_BODY="$line"
    fi
  done <<< "$OUTPUT"
  ACTUAL_STATUS="$(printf '%s' "$JSON_BODY" | jq -r '.status // ""' 2>/dev/null || echo "")"
  DETAIL="$(printf '%s' "$JSON_BODY" | jq -r '.detail // ""' 2>/dev/null || echo "")"

  if [ "$ACTUAL_STATUS" = "$EXPECTED_STATUS" ]; then
    echo "OK: $FIXTURE_FILE - expected=$EXPECTED_STATUS actual=$ACTUAL_STATUS"
  else
    echo "NG: $FIXTURE_FILE - expected=$EXPECTED_STATUS actual=${ACTUAL_STATUS:-（解析不能）} detail=${DETAIL}"
    FAIL=1
  fi
done

exit "$FAIL"
