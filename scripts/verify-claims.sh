#!/usr/bin/env bash
set -euo pipefail

# Stop hookから呼ばれる。直前アシスタントターンの主張（行番号・既存コード挙動・環境変数名の
# 一致等）と実際のdiffを低コストモデル(Haiku, 読み取り専用)で突き合わせ、裏取りの取れていない
# critical/important指摘があればStopをブロックする。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md
#
# テスト容易性のため、以下をすべて環境変数で上書き可能にしている（テストは
# scripts/verify-claims.test.sh 参照）:
#   VERIFY_CLAIMS_REPO_DIR      - git操作の基準ディレクトリ（省略時はこのスクリプトの親）
#   VERIFY_CLAIMS_STATE_DIR     - 状態ファイル保存先（省略時は .claude/.verify-state）
#   VERIFY_CLAIMS_MAX_RETRIES   - ブロック継続の上限回数（省略時は3、既存のMAX_REVIEW_RETRIESと揃える）
#   VERIFY_CLAIMS_TIMEOUT_SECONDS - claude -p サブプロセスのタイムアウト秒数（省略時は60）
#   VERIFY_CLAIMS_MODEL         - 検証に使うモデル（省略時は claude-haiku-4-5-20251001）
#   VERIFY_CLAIMS_VERIFIER_CMD  - 実際の`claude -p`呼び出しの代わりに使うコマンド（標準入力で
#                                 プロンプトを受け取り、findings JSONを標準出力に返すこと）

REPO_DIR="${VERIFY_CLAIMS_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_DIR"

STATE_DIR="${VERIFY_CLAIMS_STATE_DIR:-.claude/.verify-state}"
MAX_RETRIES="${VERIFY_CLAIMS_MAX_RETRIES:-3}"
TIMEOUT_SECONDS="${VERIFY_CLAIMS_TIMEOUT_SECONDS:-60}"
MODEL="${VERIFY_CLAIMS_MODEL:-claude-haiku-4-5-20251001}"

mkdir -p "$STATE_DIR"

INPUT="$(cat)"
SESSION_ID="$(printf '%s' "$INPUT" | jq -r '.session_id // "unknown"')"
TRANSCRIPT_PATH="$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty')"

# 7日より古い状態ファイルは掃除する（doc-suggest-check.shと同様のパターン）
find "$STATE_DIR" -name '*.json' -mtime +7 -delete 2>/dev/null || true

STATE_FILE="$STATE_DIR/${SESSION_ID}.json"
SKIP_MARKER="$STATE_DIR/${SESSION_ID}.skip"

emit_pass() {
  local msg="${1:-}"
  jq -n --arg msg "$msg" '{systemMessage: $msg}'
  exit 0
}

emit_block() {
  local msg="$1"
  echo "$msg" >&2
  exit 2
}

write_state() {
  local hash="$1" verdict="$2" retry="$3" findings_msg="$4"
  jq -n --arg h "$hash" --arg v "$verdict" --argjson r "$retry" --arg m "$findings_msg" \
    '{last_diff_hash: $h, last_verdict: $v, retry_count: $r, last_findings_message: $m}' \
    > "$STATE_FILE"
}

block_with_retry_check() {
  local hash="$1" findings_msg="$2"
  local new_retry=$((PREV_RETRY_COUNT + 1))
  write_state "$hash" "blocked" "$new_retry" "$findings_msg"
  if [ "$new_retry" -le "$MAX_RETRIES" ]; then
    emit_block "$(printf 'verify-claims: 未解消の指摘を検出しました(試行%d/%d):\n%s' "$new_retry" "$MAX_RETRIES" "$findings_msg")"
  else
    emit_block "$(printf 'verify-claims: %d回の自動修正を試みましたが指摘が解消されませんでした。人間の介入待ちです。誤検知の場合は `touch %s` でスキップできます。\n%s' "$MAX_RETRIES" "$SKIP_MARKER" "$findings_msg")"
  fi
}

# --- エスケープハッチ: .skipマーカーがあれば無条件pass（消費して削除） ---
if [ -f "$SKIP_MARKER" ]; then
  rm -f "$SKIP_MARKER"
  emit_pass "verify-claims: 手動オーバーライド(.skipマーカー)が使用されたため、今回の検証をスキップしました。"
fi

# --- diffハッシュ計算 ---
DIFF_CONTENT="$( { git diff HEAD; git status --porcelain; } 2>/dev/null || true)"
CURRENT_HASH="$(printf '%s' "$DIFF_CONTENT" | shasum -a 256 | awk '{print $1}')"

PREV_HASH=""
PREV_VERDICT=""
PREV_RETRY_COUNT=0
PREV_FINDINGS_MSG=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH="$(jq -r '.last_diff_hash // ""' "$STATE_FILE")"
  PREV_VERDICT="$(jq -r '.last_verdict // ""' "$STATE_FILE")"
  PREV_RETRY_COUNT="$(jq -r '.retry_count // 0' "$STATE_FILE")"
  PREV_FINDINGS_MSG="$(jq -r '.last_findings_message // ""' "$STATE_FILE")"
fi

# --- ケース1/2: diffハッシュ一致（前回状態あり） ---
if [ -n "$PREV_HASH" ] && [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  if [ "$PREV_VERDICT" = "pass" ]; then
    emit_pass ""
  fi
  if [ "$PREV_VERDICT" = "blocked" ]; then
    # 何も直さずに再Stopしようとした場合。LLM呼び出しはせずretry_countだけ消費する。
    block_with_retry_check "$CURRENT_HASH" "$PREV_FINDINGS_MSG"
  fi
fi

# --- ケース3: diffハッシュ不一致 → 検証を実行する ---
LAST_ASSISTANT_EXCERPT=""
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
  LAST_ASSISTANT_EXCERPT="$(tail -n 200 "$TRANSCRIPT_PATH" 2>/dev/null | jq -rs '
    [.[] | select(.type == "assistant")] | last as $last
    | if $last == null then "" else
        ([$last.message.content[]? | select(.type == "text") | .text] | join("\n"))
      end
  ' 2>/dev/null || echo "")"
fi

PROMPT="$(cat <<PROMPT_EOF
あなたは「主張の裏取り役」の検証サブエージェントです。以下の直前アシスタントターンの発言と、
実際のコード差分を突き合わせ、発言中の技術的主張（行番号・既存コードの挙動・環境変数名の一致等）が
実コードと矛盾していないか確認してください。読み取り専用ツールのみ使い、コードは変更しないこと。

# 直前アシスタントターンの抜粋
${LAST_ASSISTANT_EXCERPT}

# 現在のdiff
${DIFF_CONTENT}

# 出力形式
以下のJSON形式のみを出力してください。マークダウンのコードフェンスや説明文は付けないこと。
{"findings": [{"severity": "critical" | "important" | "minor", "description": "...", "evidence": "file:line等"}]}
指摘が無ければ {"findings": []} を返してください。
PROMPT_EOF
)"

run_verifier() {
  if [ -n "${VERIFY_CLAIMS_VERIFIER_CMD:-}" ]; then
    printf '%s' "$PROMPT" | eval "$VERIFY_CLAIMS_VERIFIER_CMD"
    return $?
  fi
  printf '%s' "$PROMPT" | claude -p --model "$MODEL" \
    --allowedTools "Read,Grep,Glob,Bash(git diff*),Bash(git log*),Bash(git show*),Bash(cat *),Bash(grep *),Bash(find *)"
}

# ポータブルなタイムアウト実装（macOSにGNU coreutilsのtimeoutが無い前提で、
# バックグラウンド実行+ポーリングkillで代替する）
run_verifier_with_timeout() {
  local out_file
  out_file="$(mktemp)"
  ( run_verifier > "$out_file" 2>/dev/null; echo $? > "${out_file}.exit" ) &
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

VERIFIER_EXIT=0
VERIFIER_OUTPUT="$(run_verifier_with_timeout)" || VERIFIER_EXIT=$?

if [ "$VERIFIER_EXIT" -ne 0 ]; then
  # インフラ障害時のfail-open: 検証プロセス自体の失敗はdeny-by-defaultの対象外とする
  emit_pass "verify-claims: 検証エージェントの実行に失敗したため(exit=${VERIFIER_EXIT})、今回はスキップしました。"
fi

FINDINGS_JSON="$(printf '%s' "$VERIFIER_OUTPUT" | jq -c '.findings' 2>/dev/null || echo "")"
if [ -z "$FINDINGS_JSON" ] || [ "$FINDINGS_JSON" = "null" ]; then
  # 出力自体が壊れている場合も検証プロセスの不備として扱い、fail-open
  emit_pass "verify-claims: 検証エージェントの出力を解析できなかったため、今回はスキップしました。"
fi

# deny-by-default: severity欠損・不明値はcriticalとして扱う
NORMALIZED_FINDINGS="$(printf '%s' "$FINDINGS_JSON" | jq -c '
  [.[] | .severity = (if (.severity == "critical" or .severity == "important" or .severity == "minor")
    then .severity else "critical" end)]
')"

HAS_BLOCKING="$(printf '%s' "$NORMALIZED_FINDINGS" | jq 'any(.[]; .severity == "critical" or .severity == "important")')"
FINDINGS_TEXT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -r '.[] | "- [" + .severity + "] " + .description + " (" + (.evidence // "evidence不明") + ")"')"
MINOR_TEXT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -r '[.[] | select(.severity == "minor")] | .[] | "- " + .description + " (" + (.evidence // "evidence不明") + ")"')"

if [ "$HAS_BLOCKING" = "true" ]; then
  block_with_retry_check "$CURRENT_HASH" "$FINDINGS_TEXT"
fi

write_state "$CURRENT_HASH" "pass" 0 ""
if [ -n "$MINOR_TEXT" ]; then
  emit_pass "$(printf 'verify-claims: 軽微な指摘があります(ブロックはしません):\n%s' "$MINOR_TEXT")"
fi
emit_pass ""
