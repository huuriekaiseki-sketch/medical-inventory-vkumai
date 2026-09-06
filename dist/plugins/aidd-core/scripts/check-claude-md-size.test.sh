#!/bin/bash
# WHY: scripts/check-claude-md-size.sh(SessionStart hook)の回帰テスト。
# (a) CLAUDE.md / docs/agents/common.mdの行数が閾値を超えたら警告し、超えなければ
#     何も出力しないこと
# (b) CLAUDE.md + @import先（再帰）+ paths無しrulesの合計文字数が閾値を超えたら警告し、
#     paths付きrules・コードスパン内の@・存在しないimportは数えないこと（issue #711）
# を確認する。CLAUDE_PROJECT_DIR/CLAUDE_MD_LINE_LIMIT/COMMON_MD_LINE_LIMIT/
# STARTUP_CONTEXT_CHAR_LIMITでテスト用に差し替える（本物のCLAUDE.mdを書き換えないため）。
#
# 実行: bash scripts/check-claude-md-size.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/check-claude-md-size.sh"

fail=0
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
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label (unexpected: $needle)"
    fail=1
  else
    echo "  OK: $label"
  fi
}

TMPDIR_TEST="$(mktemp -d)"
cleanup() { rm -rf "$TMPDIR_TEST"; }
trap cleanup EXIT
mkdir -p "$TMPDIR_TEST/docs/agents"

echo "=== scenario 1: どちらも閾値以下 → 何も出力しない ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_empty "$OUT" "行数が閾値以下なら警告なし"

echo "=== scenario 2: CLAUDE.mdが閾値超過 → 警告する ==="
seq 1 250 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "systemMessageフィールドがある"
assert_contains "$OUT" "CLAUDE.md" "CLAUDE.mdへの言及がある"

echo "=== scenario 3: common.mdが閾値超過 → 警告する ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 350 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" bash "$SCRIPT")"
assert_contains "$OUT" "common.md" "common.mdへの言及がある"

echo "=== scenario 4: 環境変数で閾値を変更できる ==="
seq 1 50 > "$TMPDIR_TEST/CLAUDE.md"
seq 1 50 > "$TMPDIR_TEST/docs/agents/common.md"
OUT="$(CLAUDE_PROJECT_DIR="$TMPDIR_TEST" CLAUDE_MD_LINE_LIMIT=10 bash "$SCRIPT")"
assert_contains "$OUT" "systemMessage" "閾値を下げると50行でも警告される"

echo "=== scenario 5: ファイルが存在しない → クラッシュせず何も出力しない ==="
EMPTY_DIR="$(mktemp -d)"
OUT="$(CLAUDE_PROJECT_DIR="$EMPTY_DIR" bash "$SCRIPT")"
assert_empty "$OUT" "ファイル不在でもクラッシュしない"
rm -rf "$EMPTY_DIR"

echo "=== scenario 6: 常時ロード総量 = CLAUDE.md + @import（再帰）+ paths無しrules（issue #711） ==="
W="$(mktemp -d)"
mkdir -p "$W/docs/agents" "$W/.claude/rules" "$W/sub"
# CLAUDE.md 10文字 + common.md 20文字（@import）+ sub/deep.md 30文字（common.md からの相対 import）
# + rules/unscoped.md 40文字。paths 付き rules（50文字）・コードスパン内の @（`@docs/x.md`）・
# 存在しない @docs/none.md は数えない。合計 100 文字ちょうど
printf '@docs/agents/common.md\n' > "$W/CLAUDE.md"                    # 23文字だが本文は @行のみ
printf 'あいうえおかきくけこ' > "$W/sub/deep.md"                          # 10 非ASCII
printf '@../../sub/deep.md `@docs/x.md` @docs/none.md\n' > "$W/docs/agents/common.md"
printf 'unscoped rule body here!' > "$W/.claude/rules/unscoped.md"     # 24 ASCII
printf -- '---\npaths:\n  - "src/**"\n---\nscoped rule body\n' > "$W/.claude/rules/scoped.md"
CLAUDE_CHARS="$(jq -Rs 'length' "$W/CLAUDE.md")"
COMMON_CHARS="$(jq -Rs 'length' "$W/docs/agents/common.md")"
EXPECTED=$((CLAUDE_CHARS + COMMON_CHARS + 10 + 24))
OUT="$(CLAUDE_PROJECT_DIR="$W" STARTUP_CONTEXT_CHAR_LIMIT=$((EXPECTED - 1)) bash "$SCRIPT")"
assert_contains "$OUT" "合計が${EXPECTED}文字" "合計文字数が期待どおり（import再帰・unscoped rules込み）"
assert_contains "$OUT" "sub/deep.md" "import元相対で解決した深い import が内訳に出る"
assert_contains "$OUT" ".claude/rules/unscoped.md" "paths無しrulesが内訳に出る"
assert_not_contains "$OUT" "rules/scoped.md" "paths付きrulesは数えない"
assert_not_contains "$OUT" "docs/x.md" "コードスパン内の@は数えない"
OUT="$(CLAUDE_PROJECT_DIR="$W" STARTUP_CONTEXT_CHAR_LIMIT=$EXPECTED bash "$SCRIPT")"
assert_empty "$OUT" "閾値ちょうどなら警告なし"
rm -rf "$W"

echo "=== scenario 7: 実態のリポジトリで既定閾値を超えていない（超えたら分離を検討する合図） ==="
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="$(CLAUDE_PROJECT_DIR="$REPO_ROOT" bash "$SCRIPT")"
assert_not_contains "$OUT" "常時ロードされる指示ファイルの合計" "実態が STARTUP_CONTEXT_CHAR_LIMIT 以内"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
