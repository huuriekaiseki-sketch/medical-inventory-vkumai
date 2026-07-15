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
#
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

# WHY(issue #351): 「同一findingが解消されないまま」なのか「別の新しい指摘に置き換わった」のかを
# 区別せずretry_countを一律加算すると、長いセッションで散発的な別々の正当な指摘が出るだけで
# 上限(MAX_RETRIES)に達し人間介入待ちになってしまう。findingの同一性(severity/description/evidence
# の集合をソートしたフィンガープリント)で判定し、同一の指摘が残っている場合のみ累積し、
# 指摘の中身が変わった場合は1から数え直す(diffハッシュを変えるだけで同じ問題を放置する
# ズルは、diffハッシュ不一致→再検証のたびに同一findingが再検出される限り引き続き累積されるため防げる)。
block_with_retry_check() {
  local hash="$1" findings_msg="$2" fingerprint="${3:-}"
  local new_retry
  if [ "$PREV_VERDICT" = "blocked" ] && [ -n "$fingerprint" ] && [ "$fingerprint" = "$PREV_BLOCKING_FINGERPRINT" ]; then
    new_retry=$((PREV_RETRY_COUNT + 1))
  else
    new_retry=1
  fi
  write_state "$hash" "blocked" "$new_retry" "$findings_msg" "$fingerprint"
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
DIFF_CONTENT="$( { git diff HEAD; git status --porcelain; } 2>/dev/null || true)"
UNTRACKED_CONTENT="$(
  while IFS= read -r -d '' f; do
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
    block_with_retry_check "$CURRENT_HASH" "$PREV_FINDINGS_MSG" "$PREV_BLOCKING_FINGERPRINT"
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
  emit_pass "$(printf 'verify-claims: 検証プロセスの同時実行数が上限(%d)に達しているため、サーキットブレーカーが働き今回の検証をスキップしました(暴走防止のfail-open)。' "$MAX_CONCURRENT")"
fi

LOCK_ENTRY="$LOCK_DIR/$$"
mkdir "$LOCK_ENTRY" 2>/dev/null || true
trap 'rmdir "$LOCK_ENTRY" 2>/dev/null || true' EXIT

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
  # WHY(issue #351): critical/important findingの{severity,description,evidence}をソートして
  # ハッシュ化したものを「指摘の同一性」の判定基準にする(表示用のFINDINGS_TEXTは整形済みの
  # 人間向け文言のため、同一性判定には使わない)。
  BLOCKING_FINGERPRINT="$(printf '%s' "$NORMALIZED_FINDINGS" | jq -c '
    [.[] | select(.severity == "critical" or .severity == "important")
       | {severity, description, evidence: (.evidence // "")}] | sort
  ' | shasum -a 256 | awk '{print $1}')"
  block_with_retry_check "$CURRENT_HASH" "$FINDINGS_TEXT" "$BLOCKING_FINGERPRINT"
fi

write_state "$CURRENT_HASH" "pass" 0 ""
if [ -n "$MINOR_TEXT" ]; then
  emit_pass "$(printf 'verify-claims: 軽微な指摘があります(ブロックはしません):\n%s' "$MINOR_TEXT")"
fi
emit_pass ""
