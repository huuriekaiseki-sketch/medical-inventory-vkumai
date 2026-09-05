#!/bin/bash
# WHY: scripts/log-instructions-loaded.sh（InstructionsLoaded hook、issue #742）と
# scripts/summarize-instructions-loaded.sh の回帰テスト。公式 docs の入力例と同形の
# ペイロードで 1 行追記されること、相対化・サイズ補完・不正入力の fail-open、
# 集計の合計と回数を固定する。ログ先は INSTRUCTIONS_LOADED_LOG_FILE で sandbox に逃がす。
#
# 実行: bash scripts/log-instructions-loaded.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGGER="$SCRIPT_DIR/log-instructions-loaded.sh"
SUMMARIZER="$SCRIPT_DIR/summarize-instructions-loaded.sh"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
PROJ="$WORK/proj"
mkdir -p "$PROJ/.claude/rules"
LOG="$WORK/instructions-loaded.jsonl"

# 日本語 5 文字 + 改行 = 6 文字 / 16 バイト（文字数とバイト数が違うことを検証に使う）
printf 'あいうえお\n' > "$PROJ/CLAUDE.md"
printf -- '---\npaths:\n  - "e2e/**"\n---\nrule\n' > "$PROJ/.claude/rules/e2e.md"

run_logger() {
  printf '%s' "$1" | env INSTRUCTIONS_LOADED_LOG_FILE="$LOG" CLAUDE_PROJECT_DIR="$PROJ" bash "$LOGGER"
}

echo "=== scenario 1: docs の入力例と同形（file_size_bytes 無し） → 相対パス・wc -c 補完・文字数付きで 1 行 ==="
run_logger "{\"session_id\":\"s1\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"session_start\",\"file_path\":\"$PROJ/CLAUDE.md\",\"memory_type\":\"instructions\",\"cwd\":\"$PROJ\"}"
LINES="$(wc -l < "$LOG" | tr -d ' ')"
[ "$LINES" = "1" ] && ok "1 行追記" || ng "行数=$LINES"
ROW="$(tail -n 1 "$LOG")"
assert_contains "$ROW" '"filePath":"CLAUDE.md"' "PROJECT_DIR 配下は相対化"
assert_contains "$ROW" '"fileSizeBytes":16' "バイト数を wc -c で補完"
assert_contains "$ROW" '"fileChars":6' "文字数を記録"
assert_contains "$ROW" '"loadReason":"session_start"' "loadReason を記録"
if printf '%s' "$ROW" | grep -qF 'globPattern'; then ng "globPattern が無いのに出ている"; else ok "globPattern 無し"; fi

echo "=== scenario 2: path_glob_match（glob_pattern・file_size_bytes あり） → ペイロードの値を優先 ==="
run_logger "{\"session_id\":\"s1\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"path_glob_match\",\"file_path\":\"$PROJ/.claude/rules/e2e.md\",\"memory_type\":\"instructions\",\"glob_pattern\":\"e2e/**\",\"file_size_bytes\":999}"
ROW="$(tail -n 1 "$LOG")"
assert_contains "$ROW" '"globPattern":"e2e/**"' "globPattern を記録"
assert_contains "$ROW" '"fileSizeBytes":999' "ペイロードの file_size_bytes を優先"
assert_contains "$ROW" '"filePath":".claude/rules/e2e.md"' "rules も相対化"

echo "=== scenario 3: PROJECT_DIR 外のファイル（個人 CLAUDE.md 相当） → 絶対パスのまま ==="
printf 'x\n' > "$WORK/outside.md"
run_logger "{\"session_id\":\"s1\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"session_start\",\"file_path\":\"$WORK/outside.md\",\"memory_type\":\"instructions\"}"
assert_contains "$(tail -n 1 "$LOG")" "\"filePath\":\"$WORK/outside.md\"" "配下でなければ絶対パス"

echo "=== scenario 4: 存在しないファイル → サイズ・文字数無しで記録は残す ==="
run_logger "{\"session_id\":\"s1\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"compact\",\"file_path\":\"$PROJ/gone.md\",\"memory_type\":\"instructions\"}"
ROW="$(tail -n 1 "$LOG")"
assert_contains "$ROW" '"loadReason":"compact"' "記録は残る"
if printf '%s' "$ROW" | grep -qF 'fileChars'; then ng "不在ファイルに fileChars が出ている"; else ok "fileChars 無し"; fi

echo "=== scenario 5: 不正入力（別イベント / 空 / 壊れた JSON） → exit 0・追記なし ==="
BEFORE="$(wc -l < "$LOG" | tr -d ' ')"
run_logger '{"hook_event_name":"SessionStart","file_path":"/x"}'
run_logger ''
run_logger '{broken'
AFTER="$(wc -l < "$LOG" | tr -d ' ')"
[ "$BEFORE" = "$AFTER" ] && ok "追記なし（$BEFORE 行のまま）" || ng "追記された（$BEFORE → $AFTER）"

echo "=== scenario 6: 集計 → 直近セッションの起動時ロード量（session_start + include、project 配下の内数）と loadReason 別回数 ==="
# 別セッション s2 を足し、直近セッションが s2 に切り替わることを見る（timestamp は追記順で増える）。
# 実測（2026-09-05）に合わせ、@import 先は include、個人 CLAUDE.md は絶対パスで session_start、
# paths 付き rules は path_glob_match で来る。path_glob_match は起動時量に含めない
mkdir -p "$PROJ/docs"
printf 'ab\n' > "$PROJ/docs/common.md"   # 3 文字
run_logger "{\"session_id\":\"s2\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"session_start\",\"file_path\":\"$WORK/outside.md\",\"memory_type\":\"User\"}"
run_logger "{\"session_id\":\"s2\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"session_start\",\"file_path\":\"$PROJ/CLAUDE.md\",\"memory_type\":\"Project\"}"
run_logger "{\"session_id\":\"s2\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"include\",\"file_path\":\"$PROJ/docs/common.md\",\"memory_type\":\"Project\"}"
run_logger "{\"session_id\":\"s2\",\"hook_event_name\":\"InstructionsLoaded\",\"load_reason\":\"path_glob_match\",\"file_path\":\"$PROJ/.claude/rules/e2e.md\",\"memory_type\":\"Project\",\"glob_pattern\":\"e2e/**\"}"
OUT="$(bash "$SUMMARIZER" --log-file "$LOG" --days 30)"
# outside.md 2 文字 + CLAUDE.md 6 文字 + common.md 3 文字 = 11、うち project 配下 9
assert_contains "$OUT" "直近セッション（s2）の起動時ロード量（session_start + include）: 合計 11 文字（うち project 配下 9 文字）" "起動時合計と project 内数"
assert_contains "$OUT" "2セッション" "セッション数"
assert_contains "$OUT" '.claude/rules/e2e.md: 2 回 {"path_glob_match":2}' "rules のロード回数"
assert_contains "$OUT" 'CLAUDE.md: 2 回 {"session_start":2}' "CLAUDE.md のロード回数"
assert_contains "$OUT" 'docs/common.md: 1 回 {"include":1}' "@import 先のロード回数"

echo "=== scenario 7: 記録ファイルが無い → 集計は「記録なし」で exit 0 ==="
OUT="$(bash "$SUMMARIZER" --log-file "$WORK/none.jsonl")"
assert_contains "$OUT" "記録なし" "記録なしの案内"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
