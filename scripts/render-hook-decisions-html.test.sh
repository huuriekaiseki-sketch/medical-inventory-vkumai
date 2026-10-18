#!/usr/bin/env bash
# WHY: scripts/render-hook-decisions-html.sh（止めた回・ハーネスの成績・hook 一覧を静的 HTML 1 枚にする、
#      docs/specs/hook-decisions-summary.md）の回帰テスト。sandbox に設定・ドリル文書・成績・記録の fixture を
#      置き、(1) 止めた回の節が集計と同じ規則（0 件は文・少数は行・多数は表）で出る (2) hook 一覧の
#      `.test.sh` の有無と実走の最終記録日が行ごとに正しい (3) 成績コマンドが失敗したら空の表でなく断り書き
#      (4) 外部参照（http）を含まない、を固定する。
#
# 実行: bash scripts/render-hook-decisions-html.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDERER="$SCRIPT_DIR/render-hook-decisions-html.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if grep -qF -- "$2" <<<"$1"; then ok "$3"; else ng "$3" "expected: $2"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then ng "$3" "unexpected: $2"; else ok "$3"; fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi
}

command -v node >/dev/null 2>&1 || { echo "  SKIP: 確認不能（node が無い）"; echo "ALL PASSED"; exit 0; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# WHY(realpath): macOS の mktemp は symlink 配下（/var → /private/var）を返す。成績の検査
#      （check-harness-score.mjs）は入口判定が実パス比較なので、root は実パスで渡す
ROOT="$(cd "$WORK" && pwd -P)/repo"
mkdir -p "$ROOT/.claude" "$ROOT/.codex" "$ROOT/scripts/lib" "$ROOT/docs/agents" "$ROOT/logs"
NOW="2026-10-18T12:00:00Z"

# hook の登録: Claude 側 3 本（止める 2 本・警告のみ 1 本）、Codex 側は check-a を共有
cat > "$ROOT/.claude/settings.json" <<'EOF'
{"hooks":{
  "PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/check-a.sh"}]},
                {"matcher":"Write","hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/check-c.sh"}]}],
  "Stop":[{"hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/check-b.sh"}]}],
  "SessionStart":[{"hooks":[{"type":"command","command":"$CLAUDE_PROJECT_DIR/scripts/ghost.sh"}]}]
}}
EOF
cat > "$ROOT/.codex/hooks.json" <<'EOF'
{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"\"$(git rev-parse --show-toplevel)\"/scripts/check-a.sh"}]}]}}
EOF
printf '#!/usr/bin/env bash\njq -n '"'"'{hookSpecificOutput:{permissionDecision:"deny"}}'"'"'\n' > "$ROOT/scripts/check-a.sh"
printf '#!/usr/bin/env bash\necho ok\n' > "$ROOT/scripts/check-a.test.sh"
printf '#!/usr/bin/env bash\njq -n '"'"'{systemMessage:"x"}'"'"'\n' > "$ROOT/scripts/check-b.sh"
# check-c は実物の check-run-manifest-presence と同じ形: コメントに permissionDecision の語があり、
# 出力は permissionDecision: "allow" + additionalContext（警告のみ）。語だけで見ると deny / ask に誤る
printf '#!/usr/bin/env bash\n# permissionDecision: "deny" は返さない設計\njq -n '"'"'{hookSpecificOutput:{permissionDecision:"allow",additionalContext:"warn"}}'"'"'\n' > "$ROOT/scripts/check-c.sh"
# ghost.sh は登録だけあって実体が無い

# ドリル文書: check-a は 2 つの日付（見出し 09-05 と行内 10-01）→ 最新 10-01。check-b は載っていない
cat > "$ROOT/docs/agents/hook-live-drill.md" <<'EOF'
# hook 実走ドリル

## 2026-09-05 の実施結果

| イベント | hook | 判定 |
|---|---|---|
| PreToolUse | check-a | RED: deny 確認 |
| PreToolUse | check-c | 導入時（2026-10-01）に警告を確認 |

## hook 一覧と判定

| PreToolUse | check-a | 再実走（2026-10-01、別セッション） |

## 実走した版（2026-12-01 に追加）

散文の言及: 期限だけが check-a に載っていた（これは実走ではないので日付を拾ってはいけない）。
EOF

# 成績の記録: 検査本体を sandbox へ運び、ref の実在する 2 行を置く
cp "$SCRIPT_DIR/lib/check-harness-score.mjs" "$SCRIPT_DIR/lib/stdout-sync.mjs" "$ROOT/scripts/lib/"
cat > "$ROOT/docs/agents/harness-score.jsonl" <<'EOF'
{"date":"2026-10-01","repo":"fixture","issue":"#1","component":"部品A","layer":"core","verdict":"stopped","detail":"d","ref":"docs/agents/hook-live-drill.md"}
{"date":"2026-10-02","repo":"fixture","issue":"#1","component":"部品B","layer":"adapter","verdict":"missed","detail":"d","ref":"docs/agents/hook-live-drill.md"}
EOF

# 止めた回の記録: 期間内 10 行（check-a が deny 9・check-c が warn 1）
LOG="$ROOT/logs/hook-decisions.jsonl"
: > "$LOG"
for d in 01 02 03 04 05 06 07 08 09; do
  echo "{\"timestamp\":\"2026-10-${d}T01:00:00Z\",\"hook\":\"check-a\",\"decision\":\"deny\",\"rule\":\"direct_exec\",\"tool_name\":\"Bash\",\"target\":\"psql\",\"caller\":\"claude\",\"agent_type\":\"\",\"session_id\":\"s\",\"branch\":\"main\"}" >> "$LOG"
done
echo '{"timestamp":"2026-10-10T01:00:00Z","hook":"check-c","decision":"warn","rule":"manifest_missing","tool_name":"Write","target":"x.ts","caller":"claude","agent_type":"","session_id":"s","branch":"main"}' >> "$LOG"

OUT_HTML="$WORK/out/hook-decisions.html"
run() { bash "$RENDERER" --root "$ROOT" --log-file "$LOG" --now "$NOW" --out "$OUT_HTML" "$@"; }

echo "=== scenario 1: 10 件 → 止めた回の表・成績の表・hook 一覧の 3 節が 1 枚に入る ==="
MSG="$(run --days 30)"
[ -f "$OUT_HTML" ] && ok "出力ファイルが書かれる" || ng "出力ファイルが無い"
assert_contains "$MSG" "$OUT_HTML" "書いた先を標準出力に出す"
HTML="$(cat "$OUT_HTML")"
assert_contains "$HTML" "<!doctype html>" "HTML 文書"
assert_contains "$HTML" "期間内 10 件" "件数"
assert_contains "$HTML" '<th>deny</th>' "hook × decision の表"
assert_contains "$HTML" "<td>check-a</td><td>9</td><td>0</td><td>0</td><td>9</td>" "check-a の行"
assert_contains "$HTML" "機械記録" "出自の注記（機械記録）"
assert_contains "$HTML" "自己申告" "出自の注記（成績は自己申告）"
assert_contains "$HTML" "<td>部品A</td>" "成績の表に部品が出る"
assert_contains "$HTML" "<td>fix-or-drop</td>" "成績の判定列"
assert_contains "$HTML" "近似" "実走日が近似であることを書く"
assert_eq "$(grep -c "http" "$OUT_HTML" || true)" "0" "外部参照（http）を含まない"

echo "=== scenario 2: hook 一覧 — .test.sh の有無・実走の最終記録日・止める力・期間内の件数・実体なし ==="
# 行は <tr data-hook="name"> で始まり、列は tool / event / 力 / test / 実走日 / 件数
ROW_A="$(grep -F 'data-hook="check-a"' "$OUT_HTML" || true)"
ROW_B="$(grep -F 'data-hook="check-b"' "$OUT_HTML" || true)"
ROW_C="$(grep -F 'data-hook="check-c"' "$OUT_HTML" || true)"
ROW_G="$(grep -F 'data-hook="ghost"' "$OUT_HTML" || true)"
assert_contains "$ROW_A" "<td>claude, codex</td>" "check-a は両ツールに登録"
assert_contains "$ROW_A" "<td>deny / ask</td>" "check-a は permissionDecision を出す＝止める力あり"
assert_contains "$ROW_A" "<td>あり</td>" "check-a に .test.sh がある"
assert_contains "$ROW_A" "<td>2026-10-01</td>" "check-a の実走日は表の行 2 つのうち最新（散文の 2026-12-01 は拾わない）"
assert_contains "$ROW_A" "<td>9</td>" "check-a の期間内 9 件"
assert_contains "$ROW_B" "<td>なし</td>" "check-b に .test.sh が無い"
assert_contains "$ROW_B" "<td>記録なし</td>" "check-b はドリル文書に無い"
assert_contains "$ROW_B" "<td>—</td>" "check-b は止める力なし（Stop）"
assert_contains "$ROW_C" "<td>warn</td>" "check-c は allow + additionalContext＝warn（コメントの deny の語に惑わされない）"
assert_contains "$ROW_C" "<td>2026-10-01</td>" "check-c は行内の日付を拾う"
assert_contains "$ROW_G" "実体なし" "登録だけあって実体が無い hook は実体なしと出す"
assert_eq "$(grep -c 'data-hook="check-a"' "$OUT_HTML")" "1" "両ツールの同じ hook は 1 行にまとめる"

echo "=== scenario 3: 2 件 → 止めた回は表でなく 1 件 1 行、成績・一覧の表は残る ==="
LOG2="$ROOT/logs/two.jsonl"
head -n 2 "$LOG" > "$LOG2"
bash "$RENDERER" --root "$ROOT" --log-file "$LOG2" --now "$NOW" --out "$OUT_HTML" --days 30 >/dev/null
HTML="$(cat "$OUT_HTML")"
assert_contains "$HTML" "期間内 2 件" "2 件"
assert_not_contains "$HTML" '<th>deny</th>' "hook × decision の表は出ない"
assert_contains "$HTML" "<li>2026-10-02T01:00:00Z / check-a / deny / direct_exec / psql / claude</li>" "1 件 1 行"
assert_contains "$HTML" "<td>部品A</td>" "成績の表は残る"

echo "=== scenario 4: 記録が無い → 両方の可能性を書く。表は出ない。hook 一覧の件数は 0 ==="
bash "$RENDERER" --root "$ROOT" --log-file "$ROOT/logs/none.jsonl" --now "$NOW" --out "$OUT_HTML" >/dev/null
HTML="$(cat "$OUT_HTML")"
assert_contains "$HTML" "記録なし" "記録なし"
assert_contains "$HTML" "記録が黙って飛んでいる" "記録が飛んでいる可能性"
assert_not_contains "$HTML" '<th>deny</th>' "表は出ない"
ROW_A="$(grep -F 'data-hook="check-a"' "$OUT_HTML" || true)"
assert_contains "$ROW_A" "<td>0</td>" "一覧の件数は 0（止める力ありなのに 0 が見える）"

echo "=== scenario 5: 成績コマンドが失敗 → 空の表でなく断り書き（C-025） ==="
bash "$RENDERER" --root "$ROOT" --log-file "$LOG" --now "$NOW" --out "$OUT_HTML" --score-cmd "false" >/dev/null
HTML="$(cat "$OUT_HTML")"
assert_contains "$HTML" "成績を取得できませんでした" "断り書き"
assert_not_contains "$HTML" "<td>部品A</td>" "成績の表が出ない"
assert_not_contains "$HTML" "<th>component</th>" "空の表の見出しも出ない"
# 成績の記録そのものが無い（検査が exit 4）→ 「記録が無い」と区別して書く
mv "$ROOT/docs/agents/harness-score.jsonl" "$ROOT/docs/agents/harness-score.jsonl.bak"
bash "$RENDERER" --root "$ROOT" --log-file "$LOG" --now "$NOW" --out "$OUT_HTML" >/dev/null
assert_contains "$(cat "$OUT_HTML")" "成績の記録が無い" "記録なしは失敗と別の文"
mv "$ROOT/docs/agents/harness-score.jsonl.bak" "$ROOT/docs/agents/harness-score.jsonl"

echo "=== scenario 6: 設定ファイルが無い root → hook 一覧は空だと言い、落ちない ==="
EMPTY="$WORK/empty-root"
mkdir -p "$EMPTY/scripts/lib"
set +e
bash "$RENDERER" --root "$EMPTY" --log-file "$LOG" --now "$NOW" --out "$WORK/out2.html" >/dev/null 2>"$WORK/err"
CODE=$?
set -e
assert_eq "$CODE" "0" "exit 0"
assert_contains "$(cat "$WORK/out2.html")" "hook の登録が見つかりません" "一覧が空だと言う"

echo "=== scenario 7: 値はエスケープされる（hook 名に < を含む行） ==="
printf '{"timestamp":"2026-10-11T01:00:00Z","hook":"<b>x</b>","decision":"deny","rule":"r","tool_name":"Bash","target":"<script>","caller":"claude"}\n' >> "$LOG2"
bash "$RENDERER" --root "$ROOT" --log-file "$LOG2" --now "$NOW" --out "$OUT_HTML" >/dev/null
HTML="$(cat "$OUT_HTML")"
assert_contains "$HTML" "&lt;b&gt;x&lt;/b&gt;" "hook 名がエスケープされる"
assert_not_contains "$HTML" "<script>" "生の script タグが出ない"

echo "=== scenario 8: 未知の引数は exit 2 ==="
set +e
bash "$RENDERER" --bogus >/dev/null 2>&1; C1=$?
set -e
assert_eq "$C1" "2" "未知の引数"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
