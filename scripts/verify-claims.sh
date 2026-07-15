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
#   VERIFY_CLAIMS_LOCK_DIR      - サーキットブレーカー用ロック置き場（省略時は .claude/.verify-lock）
#   VERIFY_CLAIMS_MAX_CONCURRENT - 同時実行を許す検証プロセス数の上限（省略時は4）
#   VERIFY_CLAIMS_OBSERVABILITY_LOG - 効果測定ログの出力先（省略時は logs/verify-claims-observability.jsonl）
#
# 効果測定ログ（issue #355）: fail-open率・ブロック回数・skipマーカー使用回数・指摘が修正に
# つながった率を事後集計できるよう、判定のたびにJSON Linesで1行追記する。「役に立っているか
# を機械的に知る手段が無い」状態（docs/agents/decisions.md「なぜ新しい運用ルールに検知手段を
# 先に決める原則を導入したか」参照）を避けるための措置。ログ書き込み自体の失敗は検証結果の
# 判定に影響させない（fail-open。詳細はlog_event()参照）。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md の「効果測定」節
# サーキットブレーカー（issue #359）: --setting-sources ""等の個別修正が正しくても、
# それが適用され忘れる・マージされ忘れることで同種の再帰暴走が繰り返された実績がある
# (2026-07-14初回発生・2026-07-15に修正未マージのまま再発)。個別修正の正しさに依存せず、
# 同時に生きている検証プロセス数を機械的に頭打ちにすることで被害を抑える。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md の「サーキットブレーカー」節

REPO_DIR="${VERIFY_CLAIMS_REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
cd "$REPO_DIR"

STATE_DIR="${VERIFY_CLAIMS_STATE_DIR:-.claude/.verify-state}"
MAX_RETRIES="${VERIFY_CLAIMS_MAX_RETRIES:-3}"
TIMEOUT_SECONDS="${VERIFY_CLAIMS_TIMEOUT_SECONDS:-60}"
MODEL="${VERIFY_CLAIMS_MODEL:-claude-haiku-4-5-20251001}"
LOCK_DIR="${VERIFY_CLAIMS_LOCK_DIR:-.claude/.verify-lock}"
MAX_CONCURRENT="${VERIFY_CLAIMS_MAX_CONCURRENT:-4}"
OBS_LOG_FILE="${VERIFY_CLAIMS_OBSERVABILITY_LOG:-logs/verify-claims-observability.jsonl}"

mkdir -p "$STATE_DIR" "$LOCK_DIR"

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
  local hash="$1" verdict="$2" retry="$3" findings_msg="$4" fingerprint="${5:-}"
  jq -n --arg h "$hash" --arg v "$verdict" --argjson r "$retry" --arg m "$findings_msg" --arg fp "$fingerprint" \
    '{last_diff_hash: $h, last_verdict: $v, retry_count: $r, last_findings_message: $m, last_blocking_fingerprint: $fp}' \
    > "$STATE_FILE"
}

# 効果測定ログへの1行追記(issue #355)。引数はすべて位置引数:
#   $1 event                : block | pass | fail_open | skip_used
#   $2 verifier_called      : true|false (claude -pサブプロセスを実際に呼んだか。コスト発生の有無)
#   $3 retry_count          : 整数
#   $4 retry_exhausted      : true|false (retry_countがMAX_RETRIESを超え人間の介入待ちになったか)
#   $5 fail_open_reason     : verifier_error|parse_error|circuit_breaker|""(該当なしはnullで記録)
#   $6 was_previously_blocked : true|false (pass時、直前状態がblockedだったか=このpassが「修正」を意味するか)
#   $7 diff_hash            : sha256、または不明時は""(nullで記録)
# ログ書き込みの失敗(ディスクフル等)は検証結果の判定に影響させない(末尾の`|| true`)。
log_event() {
  local event="$1" verifier_called="$2" retry_count="$3" retry_exhausted="$4"
  local fail_open_reason="$5" was_previously_blocked="$6" diff_hash="$7"
  local timestamp
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  mkdir -p "$(dirname "$OBS_LOG_FILE")" 2>/dev/null || true
  jq -nc \
    --arg timestamp "$timestamp" \
    --arg session_id "$SESSION_ID" \
    --arg event "$event" \
    --argjson verifier_called "$verifier_called" \
    --argjson retry_count "$retry_count" \
    --argjson retry_exhausted "$retry_exhausted" \
    --arg fail_open_reason "$fail_open_reason" \
    --argjson was_previously_blocked "$was_previously_blocked" \
    --arg diff_hash "$diff_hash" \
    '{timestamp: $timestamp, session_id: $session_id, event: $event, verifier_called: $verifier_called,
      retry_count: $retry_count, retry_exhausted: $retry_exhausted,
      fail_open_reason: (if $fail_open_reason == "" then null else $fail_open_reason end),
      was_previously_blocked: $was_previously_blocked,
      diff_hash: (if $diff_hash == "" then null else $diff_hash end)}' \
    >> "$OBS_LOG_FILE" 2>/dev/null || true
}

# WHY(issue #351): 「同一findingが解消されないまま」なのか「別の新しい指摘に置き換わった」のかを
# 区別せずretry_countを一律加算すると、長いセッションで散発的な別々の正当な指摘が出るだけで
# 上限(MAX_RETRIES)に達し人間介入待ちになってしまう。findingの同一性(severity/description/evidence
# の集合をソートしたフィンガープリント)で判定し、同一の指摘が残っている場合のみ累積し、
# 指摘の中身が変わった場合は1から数え直す(diffハッシュを変えるだけで同じ問題を放置する
# ズルは、diffハッシュ不一致→再検証のたびに同一findingが再検出される限り引き続き累積されるため防げる)。
block_with_retry_check() {
  local hash="$1" findings_msg="$2" fingerprint="${3:-}" verifier_called="${4:-false}"
  local new_retry
  if [ "$PREV_VERDICT" = "blocked" ] && [ -n "$fingerprint" ] && [ "$fingerprint" = "$PREV_BLOCKING_FINGERPRINT" ]; then
    new_retry=$((PREV_RETRY_COUNT + 1))
  else
    new_retry=1
  fi
  local exhausted="false"
  if [ "$new_retry" -gt "$MAX_RETRIES" ]; then
    exhausted="true"
  fi
  write_state "$hash" "blocked" "$new_retry" "$findings_msg" "$fingerprint"
  log_event "block" "$verifier_called" "$new_retry" "$exhausted" "" "false" "$hash"
  if [ "$new_retry" -le "$MAX_RETRIES" ]; then
    emit_block "$(printf 'verify-claims: 未解消の指摘を検出しました(試行%d/%d):\n%s' "$new_retry" "$MAX_RETRIES" "$findings_msg")"
  else
    emit_block "$(printf 'verify-claims: %d回の自動修正を試みましたが指摘が解消されませんでした。人間の介入待ちです。誤検知の場合は `touch %s` でスキップできます。\n%s' "$MAX_RETRIES" "$SKIP_MARKER" "$findings_msg")"
  fi
}

# --- diffハッシュ計算 ---
# WHY(issue #352): `git diff HEAD` はtrackedファイルの差分のみを含み、`git status --porcelain`は
# untrackedファイルを `?? path` の1行としか出さず中身を含まない。そのため新規(untracked)ファイルの
# 中身だけを直して再Stopしてもハッシュが変わらず、「何も直していない」ケースと誤判定されてしまう。
# claude_stop_notify.sh側のgit add -Aが先に走っていれば偶然trackedになり救われるが、hookの実行順序に
# 依存する暗黙のカップリングだったため、ここではuntrackedファイルの中身を直接読んでハッシュ対象に含める
# (indexは変更しない = git add -N等でこのスクリプトが副作用的にリポジトリ状態を書き換えない)。
#
# WHY(自己参照バグ対策): このスクリプト自身が書き込む状態ファイル(STATE_DIR)・ロック(LOCK_DIR)・
# 効果測定ログ(OBS_LOG_FILEの配置先ディレクトリ)がuntrackedのままだと、ログ追記のたびに中身が
# 変化し、それ自体がdiffハッシュに混入して「何もソースを直していないのにハッシュが変わり続ける」
# 自己参照バグになる(このプロジェクトでは/logs/・.claude/.verify-state/がgitignore対象のため
# 実害はないが、.gitignoreの存在に暗黙依存させず、スクリプト自身でも明示的に除外する)。
# `git status --porcelain`の`?? path`行(パスのみ・中身は含まない)にも同じ除外を適用する必要が
# ある。UNTRACKED_CONTENTのループだけ除外しても、この`?? path`行自体が新規追加/削除されると
# それだけでDIFF_CONTENTが変化してしまうため。
# `git ls-files`/`git status --porcelain`はリポジトリルート相対のパスを返す一方、
# STATE_DIR/LOCK_DIR/OBS_LOG_FILEは環境変数で絶対パスに上書きされる可能性があるため、
# 比較前に両者を絶対パスへ正規化する(相対パスのまま前方一致比較すると、絶対パスで上書き
# された場合に除外が効かなくなる)。さらに、正規化後の除外ディレクトリがリポジトリ配下
# (REPO_DIR_ABS配下)に無い場合は除外対象に加えない: 除外ディレクトリがリポジトリの祖先
# ディレクトリだと、「$ancestor/*」というglobがリポジトリ配下の全ファイルに一致してしまい、
# 本来除外すべきでないファイルまで丸ごとハッシュ対象から消えてしまう。
REPO_DIR_ABS="$(pwd)"
to_abs_path() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$REPO_DIR_ABS" "$1" ;;
  esac
}
is_within_repo() {
  [[ "$1" == "$REPO_DIR_ABS" || "$1" == "$REPO_DIR_ABS"/* ]]
}
is_excluded_path() {
  local abs
  abs="$(to_abs_path "$1")"
  [[ ( -n "$STATE_DIR_ABS" && "$abs" == "$STATE_DIR_ABS"/* ) || ( -n "$LOCK_DIR_ABS" && "$abs" == "$LOCK_DIR_ABS"/* ) || ( -n "$OBS_LOG_DIR_ABS" && "$abs" == "$OBS_LOG_DIR_ABS"/* ) ]]
}
STATE_DIR_ABS="$(to_abs_path "$STATE_DIR")"
is_within_repo "$STATE_DIR_ABS" || STATE_DIR_ABS=""
LOCK_DIR_ABS="$(to_abs_path "$LOCK_DIR")"
is_within_repo "$LOCK_DIR_ABS" || LOCK_DIR_ABS=""
OBS_LOG_DIR_ABS="$(to_abs_path "$(dirname "$OBS_LOG_FILE")")"
is_within_repo "$OBS_LOG_DIR_ABS" || OBS_LOG_DIR_ABS=""

STATUS_PORCELAIN="$(git status --porcelain 2>/dev/null || true)"
FILTERED_STATUS=""
while IFS= read -r status_line; do
  [ -n "$status_line" ] || continue
  if [[ "$status_line" == '?? '* ]] && is_excluded_path "${status_line#\?\? }"; then
    continue
  fi
  FILTERED_STATUS="$(printf '%s\n%s' "$FILTERED_STATUS" "$status_line")"
done <<< "$STATUS_PORCELAIN"

DIFF_CONTENT="$( { git diff HEAD 2>/dev/null || true; printf '%s' "$FILTERED_STATUS"; } )"
UNTRACKED_CONTENT="$(
  while IFS= read -r -d '' f; do
    if is_excluded_path "$f"; then
      continue
    fi
    printf '%s\0' "$f"
    cat -- "$f" 2>/dev/null
  done < <(git ls-files --others --exclude-standard -z 2>/dev/null || true)
)"
CURRENT_HASH="$(printf '%s%s' "$DIFF_CONTENT" "$UNTRACKED_CONTENT" | shasum -a 256 | awk '{print $1}')"

# --- エスケープハッチ: .skipマーカーがあれば無条件pass（消費して削除） ---
# WHY(issue #372): write_stateを呼ばずにexitすると、STATE_FILEのlast_verdictが直前のblockedのまま
# 残り、次のStopイベントでdiffハッシュが変化していない場合に「ケース1/2」分岐でblockedが復活してしまう。
# .skipは「そのStopイベント1回だけ」のはずなので、消費時点のCURRENT_HASHとpass判定を書き込んで
# 以降のStopイベントに影響を残さないようにする。
if [ -f "$SKIP_MARKER" ]; then
  rm -f "$SKIP_MARKER"
  write_state "$CURRENT_HASH" "pass" 0 ""
  log_event "skip_used" "false" "0" "false" "" "false" "$CURRENT_HASH"
  emit_pass "verify-claims: 手動オーバーライド(.skipマーカー)が使用されたため、今回の検証をスキップしました。"
fi

PREV_HASH=""
PREV_VERDICT=""
PREV_RETRY_COUNT=0
PREV_FINDINGS_MSG=""
PREV_BLOCKING_FINGERPRINT=""
if [ -f "$STATE_FILE" ]; then
  PREV_HASH="$(jq -r '.last_diff_hash // ""' "$STATE_FILE")"
  PREV_VERDICT="$(jq -r '.last_verdict // ""' "$STATE_FILE")"
  PREV_RETRY_COUNT="$(jq -r '.retry_count // 0' "$STATE_FILE")"
  PREV_FINDINGS_MSG="$(jq -r '.last_findings_message // ""' "$STATE_FILE")"
  PREV_BLOCKING_FINGERPRINT="$(jq -r '.last_blocking_fingerprint // ""' "$STATE_FILE")"
fi

# --- ケース1/2: diffハッシュ一致（前回状態あり） ---
if [ -n "$PREV_HASH" ] && [ "$CURRENT_HASH" = "$PREV_HASH" ]; then
  if [ "$PREV_VERDICT" = "pass" ]; then
    emit_pass ""
  fi
  if [ "$PREV_VERDICT" = "blocked" ]; then
    # 何も直さずに再Stopしようとした場合。LLM呼び出しはせずretry_countだけ消費する。
    # フィンガープリントは前回と同一のものをそのまま渡す(同一findingとして必ず累積させる)。
    block_with_retry_check "$CURRENT_HASH" "$PREV_FINDINGS_MSG" "$PREV_BLOCKING_FINGERPRINT" "false"
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
あなたは「主張の裏取り役」の検証サブエージェントです。役割は、直前アシスタントターンの発言中の
「検証可能な技術的主張」が実際のコードと矛盾していないかを確認することだけです。
読み取り専用ツールのみ使い、コードは変更しないこと。

# 裏取り対象とする主張の型(例)
- 参照関係の主張: 「XはYを参照している/呼んでいる」「XはYに依存している」
- 既存コードの挙動に関する主張: 「この関数は既にZを処理している/ハンドリングしている」「〜という分岐が既に存在する」
- 識別子・位置の一致に関する主張: 行番号・環境変数名・関数名・ファイルパス等が実コードと一致しているか

# 対象外(findingsに含めないこと)
一般的なコードレビュー(設計の良し悪し・命名規約・可読性・ベストプラクティス等)は別のreviewer
エージェントの役割であり、あなたの担当ではありません。発言の中で明示的に述べられていない、
あなた自身が新たに見つけた一般的なコード品質の懸念も対象外です。「主張と実コードが矛盾しているか」
だけを見てください。

# 出力ルール
- 指摘には必ずevidence(file:line等、実際のコードの根拠箇所)を含めること。evidenceを示せない
  指摘(=検証しようがない曖昧な懸念)はfindingsに含めないこと

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
  # --setting-sources "": ユーザー/プロジェクトのsettings.jsonを一切読み込ませない。
  # これが無いと、このサブプロセス自身がStopイベントでStop hook一式(このverify-claims.sh自身や
  # グローバルのclaude_stop_notify.sh等)を継承・再発火させ、子プロセスが際限なく増殖する
  # (2026-07-14に実際に発生、約15分で343セッションが生成されアラート音が鳴り続けた)。
  # --no-session-persistence: 検証専用の使い捨てセッションのため、transcriptを永続化しない。
  printf '%s' "$PROMPT" | claude -p --model "$MODEL" \
    --allowedTools "Read,Grep,Glob,Bash(git diff*),Bash(git log*),Bash(git show*),Bash(cat *),Bash(grep *),Bash(find *)" \
    --setting-sources "" \
    --no-session-persistence
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

# --- サーキットブレーカー: 同時実行中の検証プロセス数が上限を超えたら新規起動を拒否しfail-open ---
# 死んだプロセスのロックエントリ(前回異常終了で残った分)を先に掃除する。
# mkdirはPOSIX上atomicなのでロック用途に使える(claude_auto_issue.shと同じパターン)。
for entry in "$LOCK_DIR"/*; do
  [ -e "$entry" ] || continue
  entry_pid="$(basename "$entry")"
  if ! kill -0 "$entry_pid" 2>/dev/null; then
    rmdir "$entry" 2>/dev/null || true
  fi
done

CURRENT_CONCURRENT="$(find "$LOCK_DIR" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CURRENT_CONCURRENT" -ge "$MAX_CONCURRENT" ]; then
  log_event "fail_open" "false" "0" "false" "circuit_breaker" "false" "$CURRENT_HASH"
  emit_pass "$(printf 'verify-claims: 検証プロセスの同時実行数が上限(%d)に達しているため、サーキットブレーカーが働き今回の検証をスキップしました(暴走防止のfail-open)。' "$MAX_CONCURRENT")"
fi

LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

VERIFIER_EXIT=0
VERIFIER_OUTPUT="$(run_verifier_with_timeout)" || VERIFIER_EXIT=$?

if [ "$VERIFIER_EXIT" -ne 0 ]; then
  # インフラ障害時のfail-open: 検証プロセス自体の失敗はdeny-by-defaultの対象外とする
  log_event "fail_open" "true" "0" "false" "verifier_error" "false" "$CURRENT_HASH"
  emit_pass "verify-claims: 検証エージェントの実行に失敗したため(exit=${VERIFIER_EXIT})、今回はスキップしました。"
fi

FINDINGS_JSON="$(printf '%s' "$VERIFIER_OUTPUT" | jq -c '.findings' 2>/dev/null || echo "")"
if [ -z "$FINDINGS_JSON" ] || [ "$FINDINGS_JSON" = "null" ]; then
  # 出力自体が壊れている場合も検証プロセスの不備として扱い、fail-open
  log_event "fail_open" "true" "0" "false" "parse_error" "false" "$CURRENT_HASH"
  emit_pass "verify-claims: 検証エージェントの出力を解析できなかったため、今回はスキップしました。"
fi

# deny-by-default: severity欠損・不明値はcriticalとして扱う
NORMALIZED_FINDINGS="$(printf '%s' "$FINDINGS_JSON" | jq -c '
  [.[] | .severity = (if (.severity == "critical" or .severity == "important" or .severity == "minor")
    then .severity else "critical" end)]
')"

# --- evidence実在チェック(issue #354) ---
# WHY: 検証サブエージェント自身がLLMである以上、evidence(file:line)がハルシネーションで
# 実在しない箇所を指している可能性がある。「裏取り装置が裏取りされていない」状態を防ぐため、
# evidenceが指すファイル・行番号が実在するかを機械チェックする。実在しない/検証不能な場合は
# severityをminorへ格下げする(完全に握りつぶすと「何が起きたか分からない」サイレント劣化に
# なるため、systemMessageのminor一覧には残す。設計: docs/superpowers/specs/
# 2026-07-14-verification-subagent-design.md の「証拠検証(Evidence Verification)」節)。
verify_evidence() {
  local findings_json="$1"
  local result="[]"
  local finding evidence ev_path ev_line total_lines verified
  while IFS= read -r finding; do
    evidence="$(printf '%s' "$finding" | jq -r '.evidence // ""')"
    verified="false"
    ev_path=""
    ev_line=""
    # evidence文字列からファイルパスらしきトークン(拡張子付き) + 任意の:行番号を抽出する。
    # ベストエフォート: 拡張子の無いパス(例: scripts/lib/foo)は検知できない既知の限界がある。
    if [[ "$evidence" =~ ([A-Za-z0-9_./-]+\.[A-Za-z0-9]+)(:([0-9]+))? ]]; then
      ev_path="${BASH_REMATCH[1]}"
      ev_line="${BASH_REMATCH[3]}"
      if [ -f "$ev_path" ]; then
        if [ -z "$ev_line" ]; then
          verified="true"
        else
          total_lines="$(wc -l < "$ev_path" 2>/dev/null | tr -d ' ')"
          total_lines="${total_lines:-0}"
          # +1: 末尾行に改行が無いファイル(wc -lが最終行を数えない)への許容
          if [ "$ev_line" -ge 1 ] && [ "$ev_line" -le "$((total_lines + 1))" ]; then
            verified="true"
          fi
        fi
      fi
    fi
    if [ "$verified" = "true" ]; then
      result="$(printf '%s' "$result" | jq -c --argjson f "$finding" '. + [$f]')"
    else
      result="$(printf '%s' "$result" | jq -c --argjson f "$finding" \
        '. + [($f | .severity = "minor" | .description = (.description + "(evidence未検証のためminorへ格下げ: 該当箇所を確認できませんでした)"))]')"
    fi
  done < <(printf '%s' "$findings_json" | jq -c '.[]')
  printf '%s' "$result"
}
NORMALIZED_FINDINGS="$(verify_evidence "$NORMALIZED_FINDINGS")"

HAS_BLOCKING="$(printf '%s' "$NORMALIZED_FINDINGS" | jq 'any(.[]; .severity == "critical" or .severity == "important")')"
FINDINGS_TEXT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -r '.[] | "- [" + .severity + "] " + .description + " (" + (.evidence // "evidence不明") + ")"')"
MINOR_TEXT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -r '[.[] | select(.severity == "minor")] | .[] | "- " + .description + " (" + (.evidence // "evidence不明") + ")"')"

if [ "$HAS_BLOCKING" = "true" ]; then
  # WHY(issue #351): critical/important findingの{severity,description,evidence}をソートして
  # ハッシュ化したものを「指摘の同一性」の判定基準にする(表示用のFINDINGS_TEXTは整形済みの
  # 人間向け文言のため、同一性判定には使わない)。
  BLOCKING_FINGERPRINT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -c '
    [.[] | select(.severity == "critical" or .severity == "important")
       | {severity, description, evidence: (.evidence // "")}] | sort
  ' | shasum -a 256 | awk '{print $1}')"
  block_with_retry_check "$CURRENT_HASH" "$FINDINGS_TEXT" "$BLOCKING_FINGERPRINT" "true"
fi

write_state "$CURRENT_HASH" "pass" 0 ""
WAS_PREVIOUSLY_BLOCKED="false"
if [ "$PREV_VERDICT" = "blocked" ]; then
  WAS_PREVIOUSLY_BLOCKED="true"
fi
log_event "pass" "true" "0" "false" "" "$WAS_PREVIOUSLY_BLOCKED" "$CURRENT_HASH"
if [ -n "$MINOR_TEXT" ]; then
  emit_pass "$(printf 'verify-claims: 軽微な指摘があります(ブロックはしません):\n%s' "$MINOR_TEXT")"
fi
emit_pass ""
