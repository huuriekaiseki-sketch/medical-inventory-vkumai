#!/bin/bash
# WHY: issue #343（検証サブエージェント/Stop hook自動裏取り）向けのverify-claims.shは
# claude -p のサブプロセス実行を含みコストがかかるため、VERIFY_CLAIMS_VERIFIER_CMDで
# モックに差し替えて合成hook入力で回帰テストする。
# 設計: docs/superpowers/specs/2026-07-14-verification-subagent-design.md
#
# 実行: bash scripts/verify-claims.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/verify-claims.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

REPO="$WORKDIR/repo"
mkdir -p "$REPO"
(
  cd "$REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "line1" > file.txt
  git add file.txt
  git commit -q -m "init"
)

STATE_DIR="$WORKDIR/state"
OBS_LOG="$WORKDIR/observability.jsonl"
MOCK_VERIFIER="$WORKDIR/mock-verifier.sh"
MOCK_CALL_LOG="$WORKDIR/call.log"
MOCK_FINDINGS_FILE="$WORKDIR/findings.json"

cat > "$MOCK_VERIFIER" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
echo "called" >> "$MOCK_CALL_LOG"
sleep "${MOCK_SLEEP:-0}"
# タイムアウトで打ち切られたなら、ここには届かない(scenario 37)
[ -n "${MOCK_FINISHED_MARK:-}" ] && echo "finished" > "$MOCK_FINISHED_MARK"
if [ "${MOCK_SHOULD_FAIL:-0}" = "1" ]; then
  exit 1
fi
cat "$MOCK_FINDINGS_FILE"
MOCK_EOF
chmod +x "$MOCK_VERIFIER"

fail=0
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
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}

# 呼び出しヘルパー: $1=session_id $2=uncommitted diffの有無(yes/no) 戻り値はグローバル変数で受け渡す
STDOUT_OUT=""
STDERR_OUT=""
EXIT_CODE=0
run_hook() {
  local session_id="$1"
  local input
  input="$(jq -n --arg sid "$session_id" --arg tp "$WORKDIR/no-transcript.jsonl" '{session_id: $sid, transcript_path: $tp}')"
  local err_file="$WORKDIR/stderr.tmp"
  set +e
  STDOUT_OUT="$(
    cd "$REPO"
    printf '%s' "$input" | \
      VERIFY_CLAIMS_REPO_DIR="$REPO" \
      VERIFY_CLAIMS_STATE_DIR="$STATE_DIR" \
      VERIFY_CLAIMS_OBSERVABILITY_LOG="${OBS_LOG_OVERRIDE:-$OBS_LOG}" \
      VERIFY_CLAIMS_MAX_RETRIES=3 \
      VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
      VERIFY_CLAIMS_ENFORCE="${VERIFY_CLAIMS_ENFORCE:-block}" \
      VERIFY_CLAIMS_WARN_REVIEW_BY="${VERIFY_CLAIMS_WARN_REVIEW_BY:-2999-01-01}" \
      MOCK_CALL_LOG="$MOCK_CALL_LOG" \
      MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
      MOCK_SHOULD_FAIL="${MOCK_SHOULD_FAIL:-0}" \
      MOCK_SLEEP="${MOCK_SLEEP:-0}" \
      MOCK_FINISHED_MARK="${MOCK_FINISHED_MARK:-}" \
      VERIFY_CLAIMS_TIMEOUT_SECONDS="${VERIFY_CLAIMS_TIMEOUT_SECONDS:-60}" \
      bash "$SCRIPT" 2>"$err_file"
  )"
  EXIT_CODE=$?
  STDERR_OUT="$(cat "$err_file")"
  set -e
}

call_count() {
  if [ -f "$MOCK_CALL_LOG" ]; then wc -l < "$MOCK_CALL_LOG" | tr -d ' '; else echo 0; fi
}

echo "=== scenario 1: diff無し → 即pass ==="
rm -f "$MOCK_CALL_LOG"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
run_hook "s1"
assert_eq "$EXIT_CODE" "0" "diff無しはexit 0"

echo "=== scenario 2: diff一致・前回pass → 即pass(LLM呼び出し無し) ==="
rm -f "$MOCK_CALL_LOG"
echo "line2" >> "$REPO/file.txt"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
run_hook "s2"
assert_eq "$EXIT_CODE" "0" "1回目(新規diff)はpass"
assert_eq "$(call_count)" "1" "1回目は検証エージェントが1回呼ばれる"
run_hook "s2"
assert_eq "$EXIT_CODE" "0" "2回目(同一diff)もpass"
assert_eq "$(call_count)" "1" "2回目は検証エージェントが呼ばれない(回数据え置き)"

echo "=== scenario 3: diff一致・前回blocked → LLM呼び出し無しでretry_count+1、再ブロック ==="
rm -f "$MOCK_CALL_LOG"
echo "line3" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "行番号の不一致", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s3"
assert_eq "$EXIT_CODE" "2" "1回目(新規diff・critical)はブロック"
assert_eq "$(call_count)" "1" "1回目は検証エージェントが1回呼ばれる"
run_hook "s3"
assert_eq "$EXIT_CODE" "2" "2回目(同一diff未解消)も再ブロック"
assert_eq "$(call_count)" "1" "2回目は検証エージェントが呼ばれない(LLM呼び出し無しでretry消費)"
RETRY_COUNT="$(jq -r '.retry_count' "$STATE_DIR/s3.json")"
assert_eq "$RETRY_COUNT" "2" "retry_countが2まで進む"

echo "=== scenario 4: diff不一致・critical finding → ブロック、状態ファイルに記録 ==="
rm -f "$MOCK_CALL_LOG"
echo "line4" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "important", "description": "環境変数名の不一致", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s4"
assert_eq "$EXIT_CODE" "2" "critical/important findingでブロック"
assert_contains "$STDERR_OUT" "環境変数名の不一致" "指摘内容がstderrに出力される"
VERDICT="$(jq -r '.last_verdict' "$STATE_DIR/s4.json")"
assert_eq "$VERDICT" "blocked" "状態ファイルにblockedが記録される"

echo "=== scenario 5: retry_countが上限を超える → ブロック継続、エスケープハッチ案内 ==="
rm -f "$MOCK_CALL_LOG"
echo "line5" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "解消されない指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s5"   # retry 1
run_hook "s5"   # retry 2 (diff不変)
run_hook "s5"   # retry 3 (diff不変)
run_hook "s5"   # retry 4 → 上限超過
assert_eq "$EXIT_CODE" "2" "上限超過後もブロック継続"
if grep -qF -- "touch" <<<"$STDERR_OUT"; then
  echo "  NG: ブロックメッセージにtouchという語を含まないこと"
  fail=1
else
  echo "  OK: ブロックメッセージにtouchという語を含まないこと"
fi
assert_contains "$STDERR_OUT" "人間に相談" "ブロックメッセージに人間に相談してくださいという文言が含まれる"

echo "=== scenario 6: .skipマーカーあり → 無条件pass、マーカー削除 ==="
rm -f "$MOCK_CALL_LOG"
mkdir -p "$STATE_DIR"
touch "$STATE_DIR/s6.skip"
run_hook "s6"
assert_eq "$EXIT_CODE" "0" ".skipマーカーがあれば無条件pass"
assert_eq "$(call_count)" "0" ".skipマーカー時は検証エージェントを呼ばない"
assert_contains "$STDOUT_OUT" "手動オーバーライド" "オーバーライド使用がsystemMessageに記録される"
if [ -f "$STATE_DIR/s6.skip" ]; then
  echo "  NG: .skipマーカーが消費(削除)されていない"
  fail=1
else
  echo "  OK: .skipマーカーが消費(削除)される"
fi

echo "=== scenario 7: 検証プロセス自体が失敗 → fail-openでpass ==="
rm -f "$MOCK_CALL_LOG"
echo "line7" >> "$REPO/file.txt"
MOCK_SHOULD_FAIL=1
run_hook "s7"
MOCK_SHOULD_FAIL=0
assert_eq "$EXIT_CODE" "0" "検証プロセス失敗時はfail-openでexit 0"
assert_contains "$STDOUT_OUT" "実行に失敗" "fail-openの旨がsystemMessageに記録される"

echo "=== scenario 8: 同時実行数が上限に達している → サーキットブレーカーでfail-open(LLM呼び出し無し) ==="
rm -f "$MOCK_CALL_LOG"
echo "line8" >> "$REPO/file.txt"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
LOCK_DIR="$WORKDIR/lock"
mkdir -p "$LOCK_DIR"
# 上限(2)ぶん、実際に生きているプロセス(sleepのバックグラウンドジョブ)のPIDでロックエントリを作る。
# 死んだPIDだと「前回異常終了で残ったロックの掃除」ロジックで消費されてしまうため、テストでは
# 意図的に生きたプロセスを使う。
sleep 60 & DUMMY_PID_1=$!
sleep 60 & DUMMY_PID_2=$!
mkdir -p "$LOCK_DIR/$DUMMY_PID_1" "$LOCK_DIR/$DUMMY_PID_2"
set +e
STDOUT_OUT="$(
  cd "$REPO"
  input="$(jq -n --arg sid "s8" --arg tp "$WORKDIR/no-transcript.jsonl" '{session_id: $sid, transcript_path: $tp}')"
  printf '%s' "$input" | \
    VERIFY_CLAIMS_REPO_DIR="$REPO" \
    VERIFY_CLAIMS_STATE_DIR="$STATE_DIR" \
    VERIFY_CLAIMS_OBSERVABILITY_LOG="$OBS_LOG" \
    VERIFY_CLAIMS_LOCK_DIR="$LOCK_DIR" \
    VERIFY_CLAIMS_MAX_CONCURRENT=2 \
    VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
    MOCK_CALL_LOG="$MOCK_CALL_LOG" \
    MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
    bash "$SCRIPT" 2>"$WORKDIR/stderr8.tmp"
)"
EXIT_CODE=$?
set -e
kill "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
wait "$DUMMY_PID_1" "$DUMMY_PID_2" 2>/dev/null || true
assert_eq "$EXIT_CODE" "0" "同時実行数が上限のときはfail-openでexit 0"
assert_eq "$(call_count)" "0" "上限到達時は検証エージェントを呼ばない(claude -pを増やさない)"
assert_contains "$STDOUT_OUT" "サーキットブレーカー" "サーキットブレーカーが働いた旨がsystemMessageに記録される"

echo "=== scenario 9: 実際のclaude -p呼び出しがsettings.json/hooksを継承しない設定になっている(issue #350) ==="
# 実際にclaude -pを起動するとコストがかかり、Stop hookを持たない環境ではそもそも
# 再帰を再現できないため、E2Eではなく「run_verifier()の実装が必須フラグを含むか」を
# 静的に確認する。2026-07-14/07-15に実際にこのフラグが欠落して再帰暴走した実績があるため
# (docs/superpowers/specs/2026-07-14-verification-subagent-design.md「運用インシデント」節)、
# 将来のリファクタで再度欠落することを防ぐための回帰テスト。
RUN_VERIFIER_BLOCK="$(awk '/^run_verifier\(\)/,/^}/' "$SCRIPT")"
assert_contains "$RUN_VERIFIER_BLOCK" '--setting-sources ""' "claude -p呼び出しに--setting-sources \"\"が付いている(Stop hook再帰発火防止)"
assert_contains "$RUN_VERIFIER_BLOCK" '--no-session-persistence' "claude -p呼び出しに--no-session-persistenceが付いている"

echo "=== scenario 10: untrackedファイルのみ修正 → ハッシュが変わり再検証される(issue #352) ==="
rm -f "$MOCK_CALL_LOG"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
echo "new-content-v1" > "$REPO/new-file.txt"
run_hook "s10"
assert_eq "$EXIT_CODE" "0" "untracked新規ファイル追加時はpass"
assert_eq "$(call_count)" "1" "untracked新規ファイル追加は検証エージェントが1回呼ばれる"
echo "new-content-v2" > "$REPO/new-file.txt"
run_hook "s10"
assert_eq "$EXIT_CODE" "0" "untrackedファイルの中身を書き換えてもpass"
assert_eq "$(call_count)" "2" "untrackedファイルの中身の変更だけでも再検証される(ハッシュが変わる)"
rm -f "$REPO/new-file.txt"

echo "=== scenario 11: .skip消費後、同一diffで再度Stopしてもblockedが復活しない(issue #372) ==="
rm -f "$MOCK_CALL_LOG"
echo "line11" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "解消されない指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s11"
assert_eq "$EXIT_CODE" "2" "1回目(新規diff・critical)はブロック"
touch "$STATE_DIR/s11.skip"
run_hook "s11"
assert_eq "$EXIT_CODE" "0" ".skipマーカー使用時はpass"
VERDICT_AFTER_SKIP="$(jq -r '.last_verdict' "$STATE_DIR/s11.json")"
assert_eq "$VERDICT_AFTER_SKIP" "pass" ".skip消費時に状態ファイルのlast_verdictがpassにリセットされる"
run_hook "s11"
assert_eq "$EXIT_CODE" "0" ".skip消費後、diffが変化していない3回目もblockedが復活せずpass"
assert_eq "$(call_count)" "1" ".skip消費後の3回目は検証エージェントを再度呼ばない(diffハッシュ一致・pass再利用)"

echo "=== scenario 12: プロンプトが検証対象の主張の型・対象外・evidence必須を明記している(issue #353) ==="
# 実際にclaude -pへ送るプロンプト内容はE2Eでは検証しづらいため、scenario 9と同様に
# 「PROMPT変数の実装が必須の文言を含むか」を静的に確認する。この仕組みの価値の核心は
# 「主張の裏取り」であり一般的なコードレビューではないことをプロンプトが明示していないと、
# 既存reviewer/code-reviewと重複した劣化版になってしまう
# (docs/superpowers/specs/2026-07-14-verification-subagent-design.md「検証本体」節参照)。
PROMPT_BLOCK="$(awk '/^PROMPT=/,/^PROMPT_EOF/' "$SCRIPT")"
assert_contains "$PROMPT_BLOCK" "対象外" "プロンプトに対象外(一般的なコードレビュー的指摘の除外)の明記がある"
assert_contains "$PROMPT_BLOCK" "evidence" "プロンプトにevidence必須の指示が含まれる"
assert_contains "$PROMPT_BLOCK" "参照関係の主張" "プロンプトに検証対象の主張の型(参照関係)の例示がある"

echo "=== scenario 13: diffハッシュが変わっても同一findingが残っていればretry_countは累積する(issue #351) ==="
rm -f "$MOCK_CALL_LOG"
echo "line13a" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "解消されない指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s13"
assert_eq "$EXIT_CODE" "2" "1回目(新規diff・critical)はブロック"
RETRY_1="$(jq -r '.retry_count' "$STATE_DIR/s13.json")"
assert_eq "$RETRY_1" "1" "1回目のretry_countは1"
echo "line13b(無関係な追記)" >> "$REPO/file.txt"
run_hook "s13"
assert_eq "$EXIT_CODE" "2" "2回目(diffハッシュは変わったが同一finding)もブロック"
RETRY_2="$(jq -r '.retry_count' "$STATE_DIR/s13.json")"
assert_eq "$RETRY_2" "2" "同一findingが残っている場合はretry_countが2に累積する(diffハッシュを変えるだけで足踏みするズルを防ぐ)"

echo "=== scenario 14: diffハッシュが変わり指摘の中身も変わった場合はretry_countが1にリセットされる(issue #351) ==="
rm -f "$MOCK_CALL_LOG"
echo "line14a" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "指摘A", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s14"
assert_eq "$EXIT_CODE" "2" "1回目(指摘A)はブロック"
RETRY_A="$(jq -r '.retry_count' "$STATE_DIR/s14.json")"
assert_eq "$RETRY_A" "1" "1回目のretry_countは1"
echo "line14b" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "指摘B", "evidence": "file.txt:2"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s14"
assert_eq "$EXIT_CODE" "2" "2回目(別内容の指摘B)もブロック"
RETRY_B="$(jq -r '.retry_count' "$STATE_DIR/s14.json")"
assert_eq "$RETRY_B" "1" "指摘の中身が変わった場合はretry_countが1から数え直される(累積して2にはならない)"

echo "=== scenario 15: evidenceが実在しないファイルを指すcritical finding → minorへ格下げされブロックされない(issue #354) ==="
rm -f "$MOCK_CALL_LOG"
echo "line15" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "存在しないファイルへの言及", "evidence": "src/does-not-exist.ts:10"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s15"
assert_eq "$EXIT_CODE" "0" "evidenceのファイルが実在しない場合はminor格下げでブロックされない"
assert_contains "$STDOUT_OUT" "evidence未検証" "格下げの旨がsystemMessageに含まれる"
VERDICT_S15="$(jq -r '.last_verdict' "$STATE_DIR/s15.json")"
assert_eq "$VERDICT_S15" "pass" "状態ファイルはpassとして記録される(ブロックしていないため)"

echo "=== scenario 16: evidenceのファイルは実在するが行番号が範囲外のcritical finding → minorへ格下げ(issue #354) ==="
rm -f "$MOCK_CALL_LOG"
echo "line16" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "存在しない行番号への言及", "evidence": "file.txt:9999"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s16"
assert_eq "$EXIT_CODE" "0" "evidenceの行番号がファイルの行数を超える場合はminor格下げでブロックされない"
assert_contains "$STDOUT_OUT" "evidence未検証" "格下げの旨がsystemMessageに含まれる"

echo "=== scenario 17: evidenceが空/ファイルパスらしきトークンを含まないcritical finding → minorへ格下げ(issue #354) ==="
rm -f "$MOCK_CALL_LOG"
echo "line17" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "根拠不明の指摘", "evidence": ""}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s17"
assert_eq "$EXIT_CODE" "0" "evidenceが空の場合はminor格下げでブロックされない"
assert_contains "$STDOUT_OUT" "evidence未検証" "格下げの旨がsystemMessageに含まれる"

# --- 効果測定ログ(issue #355)の内容検証 ---
log_field() {
  local sid="$1" event="$2" field="$3"
  jq -rs --arg sid "$sid" --arg ev "$event" --arg f "$field" \
    '[.[] | select(.session_id == $sid and .event == $ev)] | last | .[$f]' \
    "$OBS_LOG" 2>/dev/null
}

echo "=== scenario 18: blockイベント(新規verifier呼び出し)が正しく記録される(issue #355) ==="
V="$(log_field "s4" "block" "verifier_called")"
assert_eq "$V" "true" "新規diffでのブロックはverifier_called=trueで記録される"
RE="$(log_field "s4" "block" "retry_exhausted")"
assert_eq "$RE" "false" "retry上限内はretry_exhausted=false"

echo "=== scenario 19: block_retry(同一diff再ブロック)がverifier_called=falseで記録される(issue #355) ==="
V="$(log_field "s3" "block" "verifier_called")"
assert_eq "$V" "false" "同一diff再ブロックの最新エントリはverifier_called=false(LLM呼び出し無し)"
RC="$(log_field "s3" "block" "retry_count")"
assert_eq "$RC" "2" "retry_countが記録される"

echo "=== scenario 20: retry上限超過でretry_exhausted=trueが記録される(issue #355) ==="
RE="$(log_field "s5" "block" "retry_exhausted")"
assert_eq "$RE" "true" "上限超過後の最新blockエントリはretry_exhausted=true"

echo "=== scenario 21: 指摘解消後のpassイベントでwas_previously_blocked=trueが記録される(issue #355) ==="
rm -f "$MOCK_CALL_LOG"
echo "line21a" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "一時的な指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
run_hook "s21"
echo "line21b" >> "$REPO/file.txt"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
run_hook "s21"
assert_eq "$EXIT_CODE" "0" "指摘解消後はpass"
WAS_PREV="$(log_field "s21" "pass" "was_previously_blocked")"
assert_eq "$WAS_PREV" "true" "直前がblockedだったpassにはwas_previously_blocked=trueが記録される(=修正が効いたシグナル)"

echo "=== scenario 22: 通常passではwas_previously_blocked=falseが記録される(issue #355) ==="
WAS_PREV_S2="$(log_field "s2" "pass" "was_previously_blocked")"
assert_eq "$WAS_PREV_S2" "false" "直前がblockedでないpassはwas_previously_blocked=false"

echo "=== scenario 23: fail-open(検証プロセス失敗)がfail_open_reason=verifier_errorで記録される(issue #355) ==="
FOR="$(log_field "s7" "fail_open" "fail_open_reason")"
assert_eq "$FOR" "verifier_error" "検証プロセス失敗はfail_open_reason=verifier_errorで記録される"

echo "=== scenario 24: fail-open(同時実行数上限)がfail_open_reason=circuit_breakerで記録される(issue #355) ==="
FOR="$(log_field "s8" "fail_open" "fail_open_reason")"
assert_eq "$FOR" "circuit_breaker" "サーキットブレーカーはfail_open_reason=circuit_breakerで記録される"

echo "=== scenario 25: fail-open(出力解析失敗)がfail_open_reason=parse_errorで記録される(issue #355) ==="
rm -f "$MOCK_CALL_LOG"
echo "line25" >> "$REPO/file.txt"
echo 'not-json-output' > "$MOCK_FINDINGS_FILE"
run_hook "s25"
assert_eq "$EXIT_CODE" "0" "出力解析失敗はfail-openでexit 0"
FOR="$(log_field "s25" "fail_open" "fail_open_reason")"
assert_eq "$FOR" "parse_error" "出力解析失敗はfail_open_reason=parse_errorで記録される"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"

echo "=== scenario 26: .skipマーカー使用がskip_usedイベントとして記録される(issue #355) ==="
SKIP_COUNT="$(jq -rs --arg sid "s6" '[.[] | select(.session_id == $sid and .event == "skip_used")] | length' "$OBS_LOG")"
assert_eq "$SKIP_COUNT" "1" "skip_usedイベントが1件記録される"

echo "=== scenario 27: 効果測定ログをリポジトリ内(untracked)に置いても診断用ハッシュに混入せずキャッシュが機能する ==="
# WHY: OBS_LOG_FILEの既定値はREPO_DIR相対の"logs/..."であり、リポジトリ配下のuntrackedファイルになる。
# もしdiffハッシュ計算からこのログファイル自身を除外していないと、ログ追記のたびにハッシュが
# 変化し続け、「ハッシュ一致・前回blocked」のキャッシュ経路(LLM再呼び出し無しでretry消費)が
# 機能しなくなる自己参照バグになる(このテストスイート内では他シナリオがOBS_LOG_FILEを
# $REPO外に置いて回避しているため、他シナリオではこのバグを検知できない)。
IN_REPO_OBS_LOG="$REPO/logs/verify-claims-observability.jsonl"
rm -f "$MOCK_CALL_LOG"
echo "line27" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "解消されない指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
set +e
STDOUT_OUT="$(
  cd "$REPO"
  input="$(jq -n --arg sid "s27" --arg tp "$WORKDIR/no-transcript.jsonl" '{session_id: $sid, transcript_path: $tp}')"
  printf '%s' "$input" | \
    VERIFY_CLAIMS_REPO_DIR="$REPO" \
    VERIFY_CLAIMS_STATE_DIR="$STATE_DIR" \
    VERIFY_CLAIMS_OBSERVABILITY_LOG="$IN_REPO_OBS_LOG" \
    VERIFY_CLAIMS_ENFORCE=block \
    VERIFY_CLAIMS_MAX_RETRIES=3 \
    VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
    MOCK_CALL_LOG="$MOCK_CALL_LOG" \
    MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
    bash "$SCRIPT"
)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "1回目(新規diff・critical)はブロック"
assert_eq "$(call_count)" "1" "1回目は検証エージェントが1回呼ばれる"
set +e
STDOUT_OUT="$(
  cd "$REPO"
  input="$(jq -n --arg sid "s27" --arg tp "$WORKDIR/no-transcript.jsonl" '{session_id: $sid, transcript_path: $tp}')"
  printf '%s' "$input" | \
    VERIFY_CLAIMS_REPO_DIR="$REPO" \
    VERIFY_CLAIMS_STATE_DIR="$STATE_DIR" \
    VERIFY_CLAIMS_OBSERVABILITY_LOG="$IN_REPO_OBS_LOG" \
    VERIFY_CLAIMS_ENFORCE=block \
    VERIFY_CLAIMS_MAX_RETRIES=3 \
    VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
    MOCK_CALL_LOG="$MOCK_CALL_LOG" \
    MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
    bash "$SCRIPT"
)"
EXIT_CODE=$?
set -e
assert_eq "$EXIT_CODE" "2" "2回目(同一diff、ログ追記後)も再ブロック"
assert_eq "$(call_count)" "1" "2回目は検証エージェントを再度呼ばない(ログ追記でハッシュが変わっていないため、キャッシュ経路が機能する)"
RETRY_COUNT_S27="$(jq -r '.retry_count' "$STATE_DIR/s27.json")"
assert_eq "$RETRY_COUNT_S27" "2" "retry_countが2まで進む(キャッシュ経路でも正しくretryが消費される)"

# --- issue #815: 2 か月で 2,475 回中 2,461 回が fail_open だった件 ---
# WHY: プロンプトに「コードフェンスを付けるな」と書いてあっても、実機の Haiku は ```json で包んで返す
#      （2026-09-20 に同じ呼び方で再現。下の fixture はそのときの stdout そのまま）。出力全体を jq に
#      通していたので毎回 parse_error で fail-open し、呼ぶたびに費用だけ払って 1 回も検証していなかった。
#      scenario 25 は「JSON でない出力」しか見ておらず、「JSON だが包まれている出力」を誰も測っていなかった。
echo "=== scenario 28: コードフェンスで包まれた応答(実機の Haiku が返す形)を解析できる(issue #815) ==="
rm -f "$MOCK_CALL_LOG"
echo "line28" >> "$REPO/file.txt"
printf '```json\n{"findings": []}\n```\n' > "$MOCK_FINDINGS_FILE"
run_hook "s28"
assert_eq "$EXIT_CODE" "0" "フェンスつきの空 findings は pass"
assert_eq "$(log_field "s28" "pass" "event")" "pass" "fail_open ではなく pass として記録される(=実際に検証した)"
assert_eq "$(jq -rs --arg sid "s28" '[.[] | select(.session_id == $sid and .event == "fail_open")] | length' "$OBS_LOG")" "0" "parse_error の fail_open が記録されない"

echo "=== scenario 29: フェンス+前置きの説明文つきでも、中の critical finding を拾ってブロックする(issue #815) ==="
# WHY: 包みを外せるだけでは足りない。外した中身が**判定に届く**ことを見る(空 findings だけだと、
#      「解析に失敗して空扱い」でも scenario 28 は通ってしまう)
rm -f "$MOCK_CALL_LOG"
echo "line29" >> "$REPO/file.txt"
printf '確認しました。結果は以下のとおりです。\n\n```json\n{"findings": [{"severity": "critical", "description": "フェンスの中の指摘", "evidence": "file.txt:1"}]}\n```\n' > "$MOCK_FINDINGS_FILE"
run_hook "s29"
assert_eq "$EXIT_CODE" "2" "フェンスの中の critical finding でブロックする"
assert_contains "$STDERR_OUT" "フェンスの中の指摘" "指摘内容が stderr に出る"

echo "=== scenario 30: 解析できなかった生の出力が残る(次に原因を追えるように。issue #815) ==="
# WHY: stderr も生の出力も捨てていたので、parse_error 1,721 回・verifier_error 740 回の原因が
#      記録から追えなかった。失敗したときだけ、長さを切って状態ディレクトリに残す
rm -f "$MOCK_CALL_LOG"
echo "line30" >> "$REPO/file.txt"
echo 'not-json-output-s30' > "$MOCK_FINDINGS_FILE"
run_hook "s30"
assert_eq "$EXIT_CODE" "0" "解析できない出力は従来どおり fail-open"
assert_contains "$(cat "$STATE_DIR/s30.last-failure.txt" 2>/dev/null || echo '(file missing)')" "not-json-output-s30" "生の出力が <session>.last-failure.txt に残る"
assert_contains "$(cat "$STATE_DIR/s30.last-failure.txt" 2>/dev/null || echo '(file missing)')" "parse_error" "失敗の種類も一緒に残る"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"

echo "=== scenario 31: 警告モード(既定)ではブロックせず、指摘を systemMessage で見せる(issue #815) ==="
# WHY: 2 か月止まっていたゲートをいきなりブロックに戻すと、誤検知の率が分からないまま作業が止まる
#      (2026-09-20 に人が決めた: 数日は警告だけ)。記録上は block のまま残すので、あとで率を数えられる
rm -f "$MOCK_CALL_LOG"
echo "line31" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "警告モードの指摘", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
VERIFY_CLAIMS_ENFORCE=warn run_hook "s31"
assert_eq "$EXIT_CODE" "0" "警告モードでは critical でも exit 0(ブロックしない)"
assert_contains "$STDOUT_OUT" "警告モードの指摘" "指摘は systemMessage で見せる"
assert_contains "$STDOUT_OUT" "警告モード" "ブロックしていない理由が分かる"
assert_eq "$(log_field "s31" "block" "event")" "block" "記録は block のまま(誤検知の率をあとで数えるため)"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"

echo "=== scenario 32: 既定は警告モード。見直しの期限を過ぎたら、そのことを毎回言う(issue #815) ==="
# WHY: 「数日様子を見る」は人が思い出すことに依存すると止まる(fail-open streak の検知器がそうだった)。
#      期限を機械が言い続ける
DEFAULT_MODE_LINE="$(grep -n '^ENFORCE_MODE=' "$SCRIPT" || true)"
assert_contains "$DEFAULT_MODE_LINE" ':-warn}' "VERIFY_CLAIMS_ENFORCE 未指定の既定は warn"
rm -f "$MOCK_CALL_LOG"
echo "line32" >> "$REPO/file.txt"
echo '{"findings": [{"severity": "critical", "description": "期限切れの確認", "evidence": "file.txt:1"}]}' > "$MOCK_FINDINGS_FILE"
VERIFY_CLAIMS_ENFORCE=warn VERIFY_CLAIMS_WARN_REVIEW_BY="2000-01-01" run_hook "s32"
assert_contains "$STDOUT_OUT" "見直しの期限" "期限を過ぎていれば、その旨が systemMessage に出る"
echo "line32b" >> "$REPO/file.txt"
VERIFY_CLAIMS_ENFORCE=warn VERIFY_CLAIMS_WARN_REVIEW_BY="2999-01-01" run_hook "s32b"
if grep -qF -- "見直しの期限" <<<"$STDOUT_OUT"; then
  echo "  NG: 期限の前なのに期限切れの文言が出ている"
  fail=1
else
  echo "  OK: 期限の前は期限切れの文言を出さない(出る側と出ない側の対)"
fi
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"

echo "=== scenario 33: fail-open が続いたら、その場で「検証が機能していない」と言う(issue #815) ==="
# WHY: 連続 fail-open の検知器(check-verify-claims-fail-open-streak.sh)は前からあり、手で呼べば
#      正しく鳴った。しかし起動が人で、2 か月誰も呼ばなかった。fail-open したその場で機械が呼ぶ。
#      他のシナリオの記録が混ざらないよう、このシナリオだけ別のログに書く
OBS_LOG_OVERRIDE="$WORKDIR/streak-observability.jsonl"
export OBS_LOG_OVERRIDE
echo 'not-json-output-s33' > "$MOCK_FINDINGS_FILE"
for i in 1 2 3 4; do
  echo "line33-$i" >> "$REPO/file.txt"
  run_hook "s33"
done
if grep -qF -- "連続でfail-open" <<<"$STDOUT_OUT"; then
  echo "  NG: 閾値(5)に届く前(4 回目)なのに連続の警告が出ている"
  fail=1
else
  echo "  OK: 4 回目までは連続の警告を出さない(出ない側)"
fi
echo "line33-5" >> "$REPO/file.txt"
run_hook "s33"
assert_eq "$EXIT_CODE" "0" "連続していても fail-open のまま(ブロックはしない)"
assert_contains "$STDOUT_OUT" "連続でfail-open" "5 回連続で、検証が機能していない旨が systemMessage に出る(出る側)"
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"
echo "line33-6" >> "$REPO/file.txt"
run_hook "s33"
echo 'not-json-output-s33b' > "$MOCK_FINDINGS_FILE"
echo "line33-7" >> "$REPO/file.txt"
run_hook "s33"
if grep -qF -- "連続でfail-open" <<<"$STDOUT_OUT"; then
  echo "  NG: 間に pass が 1 回入ったのに連続の警告が出ている"
  fail=1
else
  echo "  OK: 間に pass が入れば連続は切れる"
fi
unset OBS_LOG_OVERRIDE
echo '{"findings": []}' > "$MOCK_FINDINGS_FILE"

echo "=== scenario 34: 検証器にかかった秒数が記録される(2026-09-24) ==="
# WHY: verifier_error の残った記録はどれも exit=124(タイムアウト)だったが、何秒かかったかが無く、
#      タイムアウトを延ばすか呼び方を変えるかを推測でしか決められなかった
rm -f "$MOCK_CALL_LOG"
echo "line34" >> "$REPO/file.txt"
MOCK_SLEEP=2 run_hook "s34"
SEC="$(log_field "s34" "pass" "verifier_seconds")"
if [ "$SEC" != "null" ] && [ "$SEC" -ge 2 ] 2>/dev/null; then
  echo "  OK: 2 秒眠る検証器で verifier_seconds が 2 以上($SEC)"
else
  echo "  NG: verifier_seconds が 2 以上でない(actual=$SEC)"
  fail=1
fi

echo "=== scenario 35: 検証器を呼ばない経路では verifier_seconds が null(出ない側の対) ==="
run_hook "s34"
assert_eq "$(jq -rs '[.[] | select(.session_id == "s34")] | length' "$OBS_LOG")" "1" "同一 diff の 2 回目は記録を増やさない(キャッシュ経路)"
SEC_SKIP="$(log_field "s6" "skip_used" "verifier_seconds")"
assert_eq "$SEC_SKIP" "null" "skip マーカー経路(検証器を呼ばない)は null"
SEC_CB="$(log_field "s8" "fail_open" "verifier_seconds")"
assert_eq "$SEC_CB" "null" "サーキットブレーカー経路(検証器を呼ばない)は null"

echo "=== scenario 36: タイムアウトしたときは秒数とタイムアウト値が失敗記録に残る(2026-09-24) ==="
rm -f "$MOCK_CALL_LOG"
echo "line36" >> "$REPO/file.txt"
MOCK_SLEEP=4 VERIFY_CLAIMS_TIMEOUT_SECONDS=1 run_hook "s36"
assert_eq "$EXIT_CODE" "0" "タイムアウトは fail-open"
assert_eq "$(log_field "s36" "fail_open" "fail_open_reason")" "verifier_error" "タイムアウトは verifier_error"
SEC36="$(log_field "s36" "fail_open" "verifier_seconds")"
if [ "$SEC36" != "null" ] && [ "$SEC36" -ge 1 ] 2>/dev/null; then
  echo "  OK: タイムアウト時も verifier_seconds が記録される($SEC36)"
else
  echo "  NG: タイムアウト時の verifier_seconds が無い(actual=$SEC36)"
  fail=1
fi
assert_contains "$(cat "$STATE_DIR/s36.last-failure.txt" 2>/dev/null || echo '(file missing)')" "exit=124" "失敗記録に exit=124 が残る"
assert_contains "$(cat "$STATE_DIR/s36.last-failure.txt" 2>/dev/null || echo '(file missing)')" "timeout=1" "失敗記録にタイムアウト値が残る"

echo "=== scenario 37: タイムアウトしたら検証器の子プロセスまで止める(2026-09-24) ==="
# WHY: 包んでいるサブシェルだけを kill していたので、中の claude -p は孤児(PPID=1)になって最後まで走っていた
#      (2026-09-24 実測: タイムアウト 5 秒で hook は返ったが、Haiku は約 35 秒走り続けた)。
#      結果は捨てるのに費用だけ払い、同時実行数の上限(ロックは hook 本体の PID)にも数えられない
MARK="$WORKDIR/s37.finished"
rm -f "$MOCK_CALL_LOG" "$MARK"
echo "line37" >> "$REPO/file.txt"
MOCK_SLEEP=3 MOCK_FINISHED_MARK="$MARK" VERIFY_CLAIMS_TIMEOUT_SECONDS=1 run_hook "s37"
assert_eq "$(log_field "s37" "fail_open" "fail_open_reason")" "verifier_error" "タイムアウトは verifier_error"
SEC37="$(log_field "s37" "fail_open" "verifier_seconds")"
if [ "$SEC37" != "null" ] && [ "$SEC37" -le 2 ] 2>/dev/null; then
  echo "  OK: 打ち切りがタイムアウトどおりに効く(${SEC37} 秒。3 秒眠る検証器の終わりを待たない)"
else
  echo "  NG: 検証器の終わりを待っている(verifier_seconds=${SEC37}、タイムアウト 1 秒)"
  fail=1
fi
sleep 4
if [ -f "$MARK" ]; then
  echo "  NG: タイムアウト後も検証器が最後まで走った(子プロセスが止まっていない)"
  fail=1
else
  echo "  OK: タイムアウト後に検証器は最後まで走らない(子プロセスまで止まった)"
fi

echo "=== scenario 38: 既定のタイムアウトは 80 秒で、hook 自体の上限より短い(2026-09-24) ==="
# WHY: 同じ差分でも 13 秒と 35 秒以上とばらつき、60 秒では足りないことがあった。ただし hook の上限
#      (settings.json の timeout)を超えると Claude Code が hook ごと殺し、記録すら残らない
DEFAULT_TIMEOUT_LINE="$(grep -n '^TIMEOUT_SECONDS=' "$SCRIPT" || true)"
assert_contains "$DEFAULT_TIMEOUT_LINE" ':-80}' "VERIFY_CLAIMS_TIMEOUT_SECONDS 未指定の既定は 80"
SETTINGS="$SCRIPT_DIR/../.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  HOOK_TIMEOUT="$(jq -r '[.hooks.Stop[]?.hooks[]? | select(.command | test("verify-claims\\.sh$")) | .timeout] | first // empty' "$SETTINGS")"
  if [ -n "$HOOK_TIMEOUT" ] && [ "$HOOK_TIMEOUT" -gt 80 ]; then
    echo "  OK: hook の上限($HOOK_TIMEOUT 秒)は検証器のタイムアウト(80 秒)より長い"
  else
    echo "  NG: hook の上限($HOOK_TIMEOUT)が検証器のタイムアウト(80 秒)以下。記録が残らないまま殺される"
    fail=1
  fi
else
  echo "  SKIP: settings.json が無い(配布先)。hook の上限は hooks.json 側で見る"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
