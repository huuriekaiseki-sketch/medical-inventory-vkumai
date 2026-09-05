#!/bin/bash
# WHY: scripts/check-handoff-format.sh（issue #524のStop hook）の回帰テスト。
# 実PR・実ghコマンドに依存させず、フェイクの`gh`実行可能ファイルと一時ディレクトリの
# フェイクファイル群を環境変数で注入して決定的に検証する
# （check-aidd-stats-recorded.test.shと同じパターン）。
#
# 実行: bash scripts/check-handoff-format.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-handoff-format.sh"

fail=0
assert_eq() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (expected=$expected actual=$actual)"
    fail=1
  fi
}
assert_empty() {
  local actual="$1" label="$2"
  if [ -z "$actual" ]; then
    echo "  OK: $label"
  else
    echo "  NG: $label (actual=$actual)"
    fail=1
  fi
}
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

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

MARKER="$WORK_DIR/marker.json"
TRANSCRIPT="$WORK_DIR/transcript.jsonl"
FAKE_GH="$WORK_DIR/fake-gh.sh"
PR_RESPONSE_FILE="$WORK_DIR/pr-response.json"

SESSION="session-aaa"
BRANCH="feature/test-branch"

# フェイクgh: `gh pr list ...`が呼ばれたら $PR_RESPONSE_FILE の中身をそのまま返す。
# ファイルが存在しない場合は空配列を返す（PR未検出を模す）。
PR_FILES_FILE="$WORK_DIR/pr-files.txt"
cat > "$FAKE_GH" <<'EOF'
#!/bin/bash
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  if [ -f "$PR_RESPONSE_FILE" ]; then
    cat "$PR_RESPONSE_FILE"
  else
    echo "[]"
  fi
  exit 0
fi
# `gh pr view N --json files --jq '.files[].path'` の模擬: 1行1パスのファイルをそのまま返す。
# `gh pr view N --json body --jq .body` の模擬: $PR_RESPONSE_FILE（配列）から number==N の body を返す
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  if [ "$4" = "--json" ] && [ "$5" = "files" ]; then
    if [ -f "$PR_FILES_FILE" ]; then
      cat "$PR_FILES_FILE"
    fi
    exit 0
  fi
  if [ -f "$PR_RESPONSE_FILE" ]; then
    jq -r --argjson n "$3" '.[] | select(.number == $n) | .body // ""' "$PR_RESPONSE_FILE"
  fi
  exit 0
fi
exit 1
EOF
chmod +x "$FAKE_GH"
export PR_RESPONSE_FILE PR_FILES_FILE
set_pr_files() { # 引数: 変更ファイルパス…
  printf '%s\n' "$@" > "$PR_FILES_FILE"
}

pr_command_transcript() {
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"gh pr create --title x --body y"}}]}}\n' > "$TRANSCRIPT"
}
no_pr_command_transcript() {
  printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"git status"}}]}}\n' > "$TRANSCRIPT"
}
set_pr_response() {
  # $1: PR番号, $2: PR本文
  jq -n --argjson num "$1" --arg body "$2" '[{number: $num, body: $body}]' > "$PR_RESPONSE_FILE"
}
add_pr_response() {
  # 既存の配列に $1: PR番号, $2: PR本文 を追加する（複数 PR のシナリオ用）
  jq --argjson num "$1" --arg body "$2" '. + [{number: $num, body: $body}]' "$PR_RESPONSE_FILE" > "$PR_RESPONSE_FILE.tmp"
  mv "$PR_RESPONSE_FILE.tmp" "$PR_RESPONSE_FILE"
}
# 実 transcript と同じ形: gh pr create の tool_use（id 付き）と、それに対応する tool_result（PR URL を含む）。
# 引数: PR番号…（複数可）。gh pr create → マージ → main へ戻る運用を模し、ブランチ側の pr list は空にする
pr_create_with_result_transcript() {
  : > "$TRANSCRIPT"
  local n i=0
  for n in "$@"; do
    i=$((i + 1))
    printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_%s","name":"Bash","input":{"command":"gh pr create --title x --body-file y"}}]}}\n' "$i" >> "$TRANSCRIPT"
    printf '{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_%s","content":"https://github.com/o/r/pull/%s\\n"}]}}\n' "$i" "$n" >> "$TRANSCRIPT"
    printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_m%s","name":"Bash","input":{"command":"gh pr merge %s --squash --delete-branch"}}]}}\n' "$i" "$n" >> "$TRANSCRIPT"
  done
}

run_hook() {
  set +e
  OUT="$(HANDOFF_CHECK_SESSION_ID="$SESSION" \
    HANDOFF_CHECK_TRANSCRIPT_PATH="$TRANSCRIPT" \
    HANDOFF_CHECK_MARKER_FILE="$MARKER" \
    HANDOFF_CHECK_GH_CMD="$FAKE_GH" \
    HANDOFF_CHECK_GIT_BRANCH="$BRANCH" \
    bash "$SCRIPT" < /dev/null 2>&1)"
  EXIT_CODE=$?
  set -e
}

reset_env() {
  rm -f "$MARKER" "$PR_RESPONSE_FILE" "$PR_FILES_FILE"
}

echo "=== scenario 1: PR作成/更新コマンドの形跡が無い → 沈黙 ==="
reset_env
no_pr_command_transcript
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 2: PR作成の形跡はあるがgh pr listが空配列（PR未検出） → 沈黙 ==="
reset_env
pr_command_transcript
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "出力が空である"

echo "=== scenario 3: PR本文に必須見出しが両方揃っている → 沈黙 ==="
reset_env
pr_command_transcript
set_pr_response 100 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n内容'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "見出しが揃っていれば沈黙する"

echo "=== scenario 4: PR本文に必須見出しが両方とも無い → 警告＋マーカー作成 ==="
reset_env
pr_command_transcript
set_pr_response 101 'Summary: something\n\nTest plan: something'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "PR #101" "PR番号が含まれる"
assert_contains "$OUT" "30秒サマリー" "30秒サマリーへの言及が含まれる"
assert_eq "$([ -f "$MARKER" ] && echo yes || echo no)" "yes" "警告済みマーカーが作成される"

echo "=== scenario 5: 警告済みマーカーあり（同一セッション・同一PR） → 2回目は沈黙 ==="
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "2回目の出力は空である"

echo "=== scenario 6: 別PR番号 → 警告する ==="
set_pr_response 102 'Summary only'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "PR #102" "別PR番号では抑止されない"

echo "=== scenario 7: 片方の見出しのみ（30秒サマリーのみ） → 警告する ==="
reset_env
pr_command_transcript
set_pr_response 103 $'## 30秒サマリー\n内容のみ'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "systemMessage" "片方のみでは警告される"

echo "=== scenario 9: 04 表が4値で理由付き → 沈黙 ==="
reset_env
pr_command_transcript
set_pr_response 104 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | ✅ 実施 | (自動テスト: パス) |\n| RLS/IDOR 統合（実 DB） | ➖ 今回不要 | 高リスクパスに触れていない |\n| E2E（Playwright） | 🟡 一部 | smoke のみ |\n| 直接攻撃の実測（テスト外） | ⬜ 未実施 | 認可に触れていないため次回 |\n\n## 05 何かあったら\n内容'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "4値で理由付きなら沈黙する"

echo "=== scenario 10: 04 表に4値でない状態・理由の無い ➖ / ⬜ がある → 行を名指しで警告 ==="
reset_env
pr_command_transcript
set_pr_response 105 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | 済 | CI |\n| lint | ➖ 今回不要 |  |\n| build | ⬜ 未実施 | — |\n| unit | ✅ 実施 | パス |\n\n## 05 何かあったら\n内容'
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "systemMessage" "警告が出る"
assert_contains "$OUT" "4値" "4値への言及がある"
assert_contains "$OUT" "型検査（状態" "4値でない行を種別名で名指しする"
assert_contains "$OUT" "lint（➖ なのに理由が無い）" "理由の無い ➖ を名指しする"
assert_contains "$OUT" "build（⬜ なのに理由が無い）" "理由の無い ⬜ を名指しする"
if printf '%s' "$OUT" | grep -qF 'unit（'; then
  echo "  NG: 正常行 unit が名指しされている"; fail=1
else
  echo "  OK: 正常行は名指しされない"
fi
run_hook
assert_empty "$OUT" "同一PRでは2回目は沈黙する"

echo "=== scenario 11: 04 が表ではなく箇条書き（バグ修正時の代替形式） → 検査対象外で沈黙 ==="
reset_env
pr_command_transcript
set_pr_response 106 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n- 問題→原因仮説→修正→確認結果\n\n## 05\n内容'
run_hook
assert_empty "$OUT" "表が無ければ4値検知は発火しない"

echo "=== scenario 12: package.json を変更した PR に「依存の変更」が無い → 警告 ==="
reset_env
pr_command_transcript
set_pr_response 107 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | ✅ 実施 | パス |\n\n## 05\n内容'
set_pr_files "src/app/page.tsx" "package.json" "package-lock.json"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0（block不可）"
assert_contains "$OUT" "依存の変更" "依存の変更への言及がある"
assert_contains "$OUT" "package.json" "変更された依存ファイルを名指しする"

echo "=== scenario 13: package.json を変更した PR に「依存の変更」がある → 沈黙 ==="
reset_env
pr_command_transcript
set_pr_response 108 $'## 30秒サマリー\n内容\n\n## 00 目的\n- 依存の変更: lodash 4.17.21 を追加（用途…）\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | ✅ 実施 | パス |\n\n## 05\n内容'
set_pr_files "package.json" "package-lock.json"
run_hook
assert_empty "$OUT" "記述があれば沈黙する"

echo "=== scenario 14: package.json に触れていない PR は「依存の変更」が無くても沈黙 ==="
reset_env
pr_command_transcript
set_pr_response 109 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | ✅ 実施 | パス |\n\n## 05\n内容'
set_pr_files "src/app/page.tsx" "docs/packages.md"
run_hook
assert_empty "$OUT" "依存ファイルに触れていなければ沈黙する"

echo "=== scenario 15: PR を作ってマージし main へ戻った後の Stop（ブランチに PR 無し）でも transcript の tool_result から PR を特定して警告する ==="
# WHY(2026-09-05): 従来は現在ブランチの pr list だけを見ていたため、この運用では 1 本も評価されず無音だった
reset_env
pr_create_with_result_transcript 201
set_pr_response 201 'Summary only'
rm -f "$PR_RESPONSE_FILE.branch"
BRANCH="main"
run_hook
BRANCH="feature/test-branch"
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_contains "$OUT" "PR #201" "ブランチに依存せず transcript 由来の PR 番号で警告する"

echo "=== scenario 16: 同一セッションで複数 PR を作った → 問題のある PR をすべて名指しし、マーカーは全件保持 ==="
reset_env
pr_create_with_result_transcript 202 203 204
set_pr_response 202 'no headings'
add_pr_response 203 $'## 30秒サマリー\n内容\n\n## 04 どう確認したか\n| 種別（test-matrix.md の行） | 状態 | 結果・証跡 |\n| --- | --- | --- |\n| 型検査 | ✅ 実施 | パス |\n\n## 05\n内容'
add_pr_response 204 'no headings either'
run_hook
assert_contains "$OUT" "PR #202" "1 本目の問題 PR を名指し"
assert_contains "$OUT" "PR #204" "3 本目の問題 PR を名指し"
if printf '%s' "$OUT" | grep -qF 'PR #203'; then
  echo "  NG: 正常な PR #203 が名指しされている"; fail=1
else
  echo "  OK: 正常な PR #203 は名指しされない"
fi
MARKER_KEYS="$(jq -r '.keys | length' "$MARKER")"
assert_eq "$MARKER_KEYS" "2" "マーカーに警告済み 2 件を保持"
run_hook
assert_empty "$OUT" "2 回目は両方とも抑止される"

echo "=== scenario 17: gh pr edit N の形跡 → N を対象にする（tool_result 無しでも番号はコマンドから取れる） ==="
reset_env
printf '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_e","name":"Bash","input":{"command":"gh pr edit 205 --body-file x"}}]}}\n' > "$TRANSCRIPT"
set_pr_response 205 'Summary only'
BRANCH="main"
run_hook
BRANCH="feature/test-branch"
assert_contains "$OUT" "PR #205" "gh pr edit の番号で警告する"

echo "=== scenario 18: 旧形式マーカー {key: ...} でも抑止が効く（後方互換） ==="
reset_env
pr_create_with_result_transcript 206
set_pr_response 206 'Summary only'
jq -n --arg key "${SESSION}:206" '{key: $key}' > "$MARKER"
run_hook
assert_empty "$OUT" "旧形式マーカーの key でも沈黙する"

echo "=== scenario 8: transcriptが読めない → 沈黙（fail-open） ==="
reset_env
rm -f "$TRANSCRIPT"
run_hook
assert_eq "$EXIT_CODE" "0" "exit 0"
assert_empty "$OUT" "判定不能時は沈黙する"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
