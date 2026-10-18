#!/usr/bin/env bash
# WHY: scripts/summarize-hook-decisions.sh（止めた回の記録 hook-decisions.jsonl の集計、
#      docs/specs/hook-decisions-summary.md）の回帰テスト。fixture の件数が手で数えた値と合うこと、
#      0 件 3 種（無い／空／期間外）の文言が互いに違うこと、少数は行・多数は表に切り替わること、
#      壊れた行を黙って落とさないこと（RED 方向）を固定する。記録先は --log-file で sandbox に逃がし、
#      「今」は --now で固定して日付に依存しない。
#
# 実行: bash scripts/summarize-hook-decisions.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUMMARIZER="$SCRIPT_DIR/summarize-hook-decisions.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if grep -qF -- "$2" <<<"$1"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then ng "$3" "unexpected: $2 / actual: $1"; else ok "$3"; fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi
}

command -v node >/dev/null 2>&1 || { echo "  SKIP: 確認不能（node が無い）"; echo "ALL PASSED"; exit 0; }
command -v jq >/dev/null 2>&1 || { echo "  SKIP: 確認不能（jq が無い）"; echo "ALL PASSED"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
NOW="2026-10-18T12:00:00Z"
LOG="$WORK/hook-decisions.jsonl"

# 13 行: 期間内の正しい行 10・期間外 1（8 月）・壊れた行 2（JSON 不正・decision が語彙外）。
# rule / target は中立な語彙だけを使う（この検査は共通側に配られるので固有語を書かない）
cat > "$LOG" <<'EOF'
{"timestamp":"2026-10-01T01:00:00Z","hook":"check-direct-ddl-execution","decision":"deny","rule":"direct_exec","tool_name":"Bash","target":"psql","caller":"claude","agent_type":"","session_id":"s1","branch":"main"}
{"timestamp":"2026-10-02T01:00:00Z","hook":"check-direct-ddl-execution","decision":"deny","rule":"direct_exec","tool_name":"Bash","target":"psql","caller":"claude","agent_type":"","session_id":"s1","branch":"main"}
{"timestamp":"2026-10-03T01:00:00Z","hook":"check-direct-ddl-execution","decision":"deny","rule":"mcp_execute_sql","tool_name":"mcp__db__execute_sql","target":"","caller":"unknown","agent_type":"","session_id":"","branch":"unknown"}
{"timestamp":"2026-10-04T01:00:00Z","hook":"check-readonly-bash","decision":"deny","rule":"readonly_role","tool_name":"Bash","target":"rm","caller":"claude","agent_type":"reviewer","session_id":"s2","branch":"main"}
{"timestamp":"2026-10-05T01:00:00Z","hook":"check-skip-marker-write","decision":"ask","rule":"skip_marker","tool_name":"Write","target":".skip-marker","caller":"claude","agent_type":"","session_id":"s2","branch":"main"}
{"timestamp":"2026-10-06T01:00:00Z","hook":"check-skip-marker-write","decision":"ask","rule":"skip_marker","tool_name":"apply_patch","target":".skip-marker","caller":"codex","agent_type":"","session_id":"","branch":"main"}
{not json
{"timestamp":"2026-10-07T01:00:00Z","hook":"check-dependency-change","decision":"ask","rule":"dependency_change_command","tool_name":"Bash","target":"pkg","caller":"codex","agent_type":"","session_id":"","branch":"main"}
{"timestamp":"2026-10-08T01:00:00Z","hook":"check-dependency-change","decision":"ask","rule":"dependency_change_file","tool_name":"Edit","target":"package.json","caller":"claude","agent_type":"","session_id":"s3","branch":"feature/x"}
{"timestamp":"2026-10-09T01:00:00Z","hook":"check-run-manifest-presence","decision":"warn","rule":"manifest_missing","tool_name":"Edit","target":"src/lib/x.ts","caller":"claude","agent_type":"","session_id":"s3","branch":"feature/x"}
{"timestamp":"2026-10-10T01:00:00Z","hook":"check-run-manifest-presence","decision":"warn","rule":"manifest_missing","tool_name":"Write","target":"src/lib/y.ts","caller":"claude","agent_type":"","session_id":"s3","branch":"feature/x"}
{"timestamp":"2026-10-11T01:00:00Z","hook":"check-skip-marker-write","decision":"allow","rule":"skip_marker","tool_name":"Write","target":".skip-marker","caller":"claude","agent_type":"","session_id":"s3","branch":"main"}
{"timestamp":"2026-08-01T01:00:00Z","hook":"check-direct-ddl-execution","decision":"deny","rule":"direct_exec","tool_name":"Bash","target":"psql","caller":"claude","agent_type":"","session_id":"s0","branch":"main"}
EOF

run() { bash "$SUMMARIZER" --log-file "$LOG" --now "$NOW" "$@"; }

echo "=== scenario 1: --json の件数が手で数えた値と一致する（期間内 10 / 全期間 11 / 壊れた行 2） ==="
JSON="$(run --days 30 --json)"
assert_eq "$(jq -r '.fileState' <<<"$JSON")" "present" "fileState=present"
assert_eq "$(jq -r '.total.allTime' <<<"$JSON")" "11" "全期間 11 件（壊れた行は含めない）"
assert_eq "$(jq -r '.total.inWindow' <<<"$JSON")" "10" "期間内 10 件"
assert_eq "$(jq -r '.latestTimestamp' <<<"$JSON")" "2026-10-10T01:00:00Z" "最新は 10-10（語彙外の 10-11 は数えない）"
assert_eq "$(jq -r '.byHookDecision["check-direct-ddl-execution"].deny' <<<"$JSON")" "3" "DDL deny 3"
assert_eq "$(jq -r '.byHookDecision["check-readonly-bash"].deny' <<<"$JSON")" "1" "readonly deny 1"
assert_eq "$(jq -r '.byHookDecision["check-skip-marker-write"].ask' <<<"$JSON")" "2" "skip ask 2"
assert_eq "$(jq -r '.byHookDecision["check-dependency-change"].ask' <<<"$JSON")" "2" "dependency ask 2"
assert_eq "$(jq -r '.byHookDecision["check-run-manifest-presence"].warn' <<<"$JSON")" "2" "manifest warn 2"
assert_eq "$(jq -r '.byHookDecision["check-run-manifest-presence"].deny' <<<"$JSON")" "0" "無い組み合わせは 0 で埋まる"
assert_eq "$(jq -r '.byRule.direct_exec' <<<"$JSON")" "2" "rule direct_exec 2（期間外の 1 件は含めない）"
assert_eq "$(jq -r '.byRule.manifest_missing' <<<"$JSON")" "2" "rule manifest_missing 2"
assert_eq "$(jq -r '.byRule | length' <<<"$JSON")" "7" "rule は 7 種"
assert_eq "$(jq -r '.byCaller.claude' <<<"$JSON")" "7" "caller claude 7"
assert_eq "$(jq -r '.byCaller.codex' <<<"$JSON")" "2" "caller codex 2"
assert_eq "$(jq -r '.byCaller.unknown' <<<"$JSON")" "1" "caller unknown 1"
assert_eq "$(jq -r '.codexAskRelabeledAsDeny' <<<"$JSON")" "2" "codex の ask 2 件を deny 読み替えとして数える"
assert_eq "$(jq -r '.broken.count' <<<"$JSON")" "2" "壊れた行 2 件（JSON 不正 + 語彙外 decision）"
assert_eq "$(jq -c '.broken.lines' <<<"$JSON")" "[7,12]" "壊れた行の行番号"
assert_eq "$(jq -r '.recent | length' <<<"$JSON")" "10" "直近は最大 10 件"
assert_eq "$(jq -r '.recent[0].timestamp' <<<"$JSON")" "2026-10-10T01:00:00Z" "直近は新しい順"
assert_eq "$(jq -r '.days' <<<"$JSON")" "30" "days を出す"
assert_eq "$(jq -r '.since' <<<"$JSON")" "2026-09-18T12:00:00Z" "since は now - days"

echo "=== scenario 2: 期間内 10 件 → 表で出る（hook × decision / rule 別 / caller 別 / 直近） ==="
OUT="$(run --days 30)"
assert_contains "$OUT" "| hook | deny | ask | warn | 計 |" "hook × decision の表の見出し"
assert_contains "$OUT" "| check-direct-ddl-execution | 3 | 0 | 0 | 3 |" "DDL の行"
assert_contains "$OUT" "| check-run-manifest-presence | 0 | 0 | 2 | 2 |" "manifest の行"
assert_contains "$OUT" "全期間 11 件 / 期間内 10 件" "件数の 2 値を両方出す"
assert_contains "$OUT" "壊れた行 2 件（7, 12 行目）" "壊れた行を別枠で出す"
assert_contains "$OUT" "direct_exec: 2" "rule 別"
assert_contains "$OUT" "claude: 7 / codex: 2 / unknown: 1" "caller 別"
assert_contains "$OUT" "caller=codex の ask 2 件" "Codex 読み替えの脚注"
assert_contains "$OUT" "allow は記録されない" "分母が無い注記"
assert_contains "$OUT" "直近 10 件" "直近の節"

echo "=== scenario 2b: --no-heading → 見出し行を出さない（月次サマリが自分の見出しを持つため） ==="
OUT="$(run --days 30 --no-heading)"
assert_not_contains "$OUT" "## 止める hook が止めた回" "見出しなし"
assert_contains "$OUT" "全期間 11 件 / 期間内 10 件" "中身は同じ"

echo "=== scenario 3: 期間内 9 件（--days 17） → 表を出さず 1 件 1 行 ==="
OUT="$(run --days 17)"
assert_contains "$OUT" "期間内 9 件" "9 件"
assert_not_contains "$OUT" "| hook | deny |" "表の見出しは出ない"
assert_contains "$OUT" "2026-10-02T01:00:00Z / check-direct-ddl-execution / deny / direct_exec / psql / claude" "1 件 1 行の形"
assert_not_contains "$OUT" "2026-10-01T01:00:00Z" "期間外の行は出ない"
echo "=== scenario 3b: 期間内 10 件（--days 18） → 閾値の反対側で表に切り替わる ==="
OUT="$(run --days 18)"
assert_contains "$OUT" "| hook | deny | ask | warn | 計 |" "10 件で表"

echo "=== scenario 4: 記録ファイルが無い → 両方の可能性を書いて exit 0 ==="
set +e
OUT="$(bash "$SUMMARIZER" --log-file "$WORK/none.jsonl" --now "$NOW")"
CODE=$?
set -e
assert_eq "$CODE" "0" "exit 0"
assert_contains "$OUT" "記録なし" "記録なし"
assert_contains "$OUT" "一度も deny / ask / warn を出していない" "可能性 1: 止めていない"
assert_contains "$OUT" "記録が黙って飛んでいる" "可能性 2: 記録が飛んでいる"
assert_contains "$OUT" "区別できない" "区別できないと言う"
assert_contains "$OUT" "log-hook-decision.sh" "区別する手がかり"
assert_eq "$(bash "$SUMMARIZER" --log-file "$WORK/none.jsonl" --now "$NOW" --json | jq -r '.fileState')" "missing" "json でも fileState=missing"

echo "=== scenario 5: 空ファイル → 同じく両方の可能性、fileState=empty ==="
: > "$WORK/empty.jsonl"
OUT="$(bash "$SUMMARIZER" --log-file "$WORK/empty.jsonl" --now "$NOW")"
assert_contains "$OUT" "記録なし" "記録なし"
assert_contains "$OUT" "記録が黙って飛んでいる" "可能性 2"
assert_eq "$(bash "$SUMMARIZER" --log-file "$WORK/empty.jsonl" --now "$NOW" --json | jq -r '.fileState')" "empty" "fileState=empty"

echo "=== scenario 6: 全期間には行があるが期間内 0 件（--days 5） → 「無い」とは別の文 ==="
OUT="$(run --days 5)"
assert_contains "$OUT" "直近 5 日は 0 件（全期間 11 件、最新 2026-10-10T01:00:00Z）" "期間外の文"
assert_contains "$OUT" "過去に書けていた" "記録の仕組みが動いた実績に触れる"
assert_not_contains "$OUT" "記録なし（" "「記録なし」の文は出ない"
assert_not_contains "$OUT" "| hook | deny |" "表は出ない"

echo "=== scenario 7: RED 方向 — 壊れた行を混ぜても件数は増えず、黙って消えもしない ==="
cp "$LOG" "$WORK/more-broken.jsonl"
printf '%s\n' 'garbage line' '[1,2,3]' '{"timestamp":"2026-10-12T00:00:00Z","hook":"","decision":"deny","rule":"x"}' >> "$WORK/more-broken.jsonl"
JSON2="$(bash "$SUMMARIZER" --log-file "$WORK/more-broken.jsonl" --now "$NOW" --days 30 --json)"
assert_eq "$(jq -r '.total.inWindow' <<<"$JSON2")" "10" "壊れた行を 3 行足しても期間内は 10 のまま"
assert_eq "$(jq -r '.broken.count' <<<"$JSON2")" "5" "壊れた行は 5 件に増える（落としていない）"
assert_contains "$(jq -r '.broken.reasons | join(" ")' <<<"$JSON2")" "hook が空" "必須項目の欠落も壊れた行として理由を残す"

echo "=== scenario 7b: symlink 経由のパスで起動しても出力が出る（入口判定が実パスと食い違って黙る型。C-05x） ==="
# mktemp -d は macOS では /var/folders（→ /private/var/folders の symlink）を返す。本番でも
# プラグイン配布先が symlink 配下にあり得る。黙ってスキップすると月次サマリの || true が空を飲む
mkdir -p "$WORK/real/scripts/lib"
cp "$SUMMARIZER" "$WORK/real/scripts/"
cp "$SCRIPT_DIR/lib/hook-decisions-summary.mjs" "$SCRIPT_DIR/lib/stdout-sync.mjs" "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$WORK/real/scripts/lib/"
ln -s "$WORK/real" "$WORK/link"
OUT="$(bash "$WORK/link/scripts/summarize-hook-decisions.sh" --log-file "$LOG" --now "$NOW" --days 30)"
assert_contains "$OUT" "期間内 10 件" "symlink 経由でも集計が出る"

echo "=== scenario 8: 入口の引数 — 未知の引数は exit 2、--days に数以外は exit 2 ==="
set +e
bash "$SUMMARIZER" --log-file "$LOG" --bogus >/dev/null 2>&1; C1=$?
bash "$SUMMARIZER" --log-file "$LOG" --days abc >/dev/null 2>&1; C2=$?
set -e
assert_eq "$C1" "2" "未知の引数"
assert_eq "$C2" "2" "days が数でない"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
