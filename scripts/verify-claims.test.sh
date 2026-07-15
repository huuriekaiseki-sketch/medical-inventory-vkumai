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
if [ "${MOCK_SHOULD_FAIL:-0}" = "1" ]; then
  exit 1
fi
cat "$MOCK_FINDINGS_FILE"
MOCK_EOF
chmod +x "$MOCK_VERIFIER"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
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
      VERIFY_CLAIMS_OBSERVABILITY_LOG="$OBS_LOG" \
      VERIFY_CLAIMS_MAX_RETRIES=3 \
      VERIFY_CLAIMS_VERIFIER_CMD="$MOCK_VERIFIER" \
      MOCK_CALL_LOG="$MOCK_CALL_LOG" \
      MOCK_FINDINGS_FILE="$MOCK_FINDINGS_FILE" \
      MOCK_SHOULD_FAIL="${MOCK_SHOULD_FAIL:-0}" \
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
assert_contains "$STDERR_OUT" "touch" "エスケープハッチ(.skipマーカー作成方法)の案内が出力される"
assert_contains "$STDERR_OUT" "s5.skip" "案内にセッション固有のskipマーカーパスが含まれる"

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

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
