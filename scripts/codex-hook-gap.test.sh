#!/bin/bash
# WHY: 2026-09-30、仕様書 docs/specs/codex-hook-parity/07-claude-only-hooks.md。
#      Claude Code の hook は 47 件、Codex は 8 件だった。差の 40 件は、誰も一覧にしておらず、
#      「14 件ほど」と数え間違えたまま話が進んでいた。差を実登録から計算し、1 件ずつ
#      「持っていく・作り直す・持っていかない」を決めた一覧（scripts/lib/codex-hook-gap.json）と
#      突き合わせる。Claude 側に hook を足して、Codex での扱いを決めていなければ落ちる。
#
# WHY(不在で判定しない): 「Codex に無い」は、登録から名前を取り出せなかったときにも成り立って
#      しまう。取り出せた件数が 0 のときは、差を計算する前に落とす（C-025 の型）。
#
# 実行: bash scripts/codex-hook-gap.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NAMES_JQ="$SCRIPT_DIR/lib/hook-script-names.jq"

pass=0
fail=0
ok() {
  echo "  OK: $1"
  pass=$((pass + 1))
}
ng() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && printf '%s\n' "$2" | sed 's/^/      /'
  fail=$((fail + 1))
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

check_gap() {
  # $1 = 根（.claude/settings.json・.codex/hooks.json・scripts/lib/ を持つ）
  # 標準出力に違反を 1 行 1 件で出す。違反が無ければ何も出さない。
  local root="$1"
  local settings="$root/.claude/settings.json"
  local hooks="$root/.codex/hooks.json"
  local gap="$root/scripts/lib/codex-hook-gap.json"
  local list="$root/scripts/lib/codex-session-start-checks.txt"
  local t="$WORK/t"
  rm -rf "$t"
  mkdir -p "$t"

  local f
  for f in "$settings" "$hooks" "$gap" "$list"; do
    if [ ! -f "$f" ]; then
      echo "missing-file: ${f#"$root"/} が無い"
      return 0
    fi
  done
  if ! jq empty "$gap" 2>/dev/null; then
    echo "broken-registry: scripts/lib/codex-hook-gap.json が JSON として読めない"
    return 0
  fi

  jq -r -f "$NAMES_JQ" "$settings" 2>/dev/null | cut -f2 | sort -u > "$t/claude"
  jq -r -f "$NAMES_JQ" "$hooks" 2>/dev/null | cut -f2 | sort -u > "$t/codex"
  if [ ! -s "$t/claude" ]; then
    echo "empty-scan: .claude/settings.json から hook を 1 本も取り出せない（走査が壊れている）"
    return 0
  fi
  if [ ! -s "$t/codex" ]; then
    echo "empty-scan: .codex/hooks.json から hook を 1 本も取り出せない（走査が壊れている）"
    return 0
  fi

  # 相方: Claude 側の名前 → Codex 側の名前
  jq -r '.counterparts | to_entries[] | select(.key | startswith("_") | not) | "\(.key)\t\(.value)"' "$gap" > "$t/counterparts"
  : > "$t/covered"
  local claude_name codex_name
  while IFS="$(printf '\t')" read -r claude_name codex_name; do
    [ -z "$claude_name" ] && continue
    if ! grep -qxF "$claude_name" "$t/claude"; then
      echo "stale-counterpart: 相方の表の ${claude_name} が、Claude 側に登録されていない"
    fi
    if grep -qxF "$codex_name" "$t/codex"; then
      echo "$claude_name" >> "$t/covered"
    else
      echo "missing-counterpart: ${claude_name} の相方 ${codex_name} が、Codex 側に登録されていない"
    fi
  done < "$t/counterparts"
  comm -12 "$t/claude" "$t/codex" >> "$t/covered"
  sort -u "$t/covered" > "$t/covered.sorted"

  comm -23 "$t/claude" "$t/covered.sorted" > "$t/actual-gap"
  jq -r '.claudeOnly | keys[]' "$gap" | sort -u > "$t/declared-gap"

  local name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "undeclared: ${name} は Claude 側にだけ登録されているが、Codex での扱いが決まっていない"
  done <<EOF
$(comm -23 "$t/actual-gap" "$t/declared-gap")
EOF
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "stale-entry: ${name} は一覧にあるが、Claude 側にだけ登録された hook ではない（Codex に入ったか、Claude 側から消えた）"
  done <<EOF
$(comm -13 "$t/actual-gap" "$t/declared-gap")
EOF

  # 区分と理由
  jq -r '
    (.categories | keys) as $cats
    | .claudeOnly | to_entries[]
    | select((.value.category as $c | $cats | index($c)) == null)
    | "unknown-category: \(.key) の区分「\(.value.category // "")」が、区分の表に無い"
  ' "$gap"
  jq -r '
    .claudeOnly | to_entries[]
    | select(((.value.why // "") | gsub("\\s"; "")) == "")
    | "no-reason: \(.key) に理由が書かれていない"
  ' "$gap"

  # 入口が動かす点検の一覧と、区分 entry が一致する
  jq -r '.claudeOnly | to_entries[] | select(.value.category == "entry") | .key' "$gap" | sort -u > "$t/entry-declared"
  sed -e 's/#.*$//' "$list" | tr -d ' \t' | grep -v '^$' | sort -u > "$t/entry-listed"
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "entry-not-listed: ${name} は区分 entry だが、入口の一覧（codex-session-start-checks.txt）に無い"
  done <<EOF
$(comm -23 "$t/entry-declared" "$t/entry-listed")
EOF
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    echo "listed-not-entry: ${name} は入口の一覧にあるが、区分 entry として決められていない"
  done <<EOF
$(comm -13 "$t/entry-declared" "$t/entry-listed")
EOF

  # 区分 entry があるのに、入口そのものが Codex に登録されていない
  if [ -s "$t/entry-declared" ] && ! grep -qxF "codex-session-start.sh" "$t/codex"; then
    echo "entry-unregistered: 区分 entry の点検があるのに、入口（codex-session-start.sh）が Codex 側に登録されていない"
  fi
}

make_fixture() {
  # 実物を複製した根を作る。$1 = 置き場所
  local dst="$1"
  rm -rf "$dst"
  mkdir -p "$dst/.claude" "$dst/.codex" "$dst/scripts/lib"
  cp "$REPO_ROOT/.claude/settings.json" "$dst/.claude/"
  cp "$REPO_ROOT/.codex/hooks.json" "$dst/.codex/"
  cp "$REPO_ROOT/scripts/lib/codex-hook-gap.json" "$dst/scripts/lib/"
  cp "$REPO_ROOT/scripts/lib/codex-session-start-checks.txt" "$dst/scripts/lib/"
}

expect_violation() {
  # $1 = ラベル、$2 = 期待する違反の頭、$3 = 根
  local out
  out="$(check_gap "$3")"
  case "$out" in
    *"$2"*) ok "$1" ;;
    *) ng "$1" "「$2」が出ない。出力: ${out:-（なし）}" ;;
  esac
}

echo "=== scenario 1: 実物に違反が無い ==="
REAL="$(check_gap "$REPO_ROOT")"
if [ -z "$REAL" ]; then
  ok "Claude 側にだけある hook は、すべて扱いが決まっている"
else
  ng "実物に違反がある" "$REAL"
fi

echo "=== scenario 2: 走査が空振りしていない ==="
CLAUDE_COUNT="$(jq -r -f "$NAMES_JQ" "$REPO_ROOT/.claude/settings.json" | grep -c .)"
CODEX_COUNT="$(jq -r -f "$NAMES_JQ" "$REPO_ROOT/.codex/hooks.json" | grep -c .)"
CLAUDE_REG="$(jq '[.hooks[][]?.hooks[]?] | length' "$REPO_ROOT/.claude/settings.json")"
CODEX_REG="$(jq '[.hooks[][]?.hooks[]?] | length' "$REPO_ROOT/.codex/hooks.json")"
[ "$CLAUDE_COUNT" = "$CLAUDE_REG" ] && ok "Claude 側の登録 ${CLAUDE_REG} 件すべてから名前を取り出せた" || ng "Claude 側で名前を取り出せない登録がある" "登録 ${CLAUDE_REG} 件 / 取り出せた ${CLAUDE_COUNT} 件"
[ "$CODEX_COUNT" = "$CODEX_REG" ] && ok "Codex 側の登録 ${CODEX_REG} 件すべてから名前を取り出せた" || ng "Codex 側で名前を取り出せない登録がある" "登録 ${CODEX_REG} 件 / 取り出せた ${CODEX_COUNT} 件"

echo "=== scenario 3: Claude 側に hook を足して、扱いを決めていないと落ちる ==="
FIX="$WORK/fix"
make_fixture "$FIX"
jq '.hooks.SessionStart[0].hooks += [{"type":"command","command":"\"$CLAUDE_PROJECT_DIR\"/scripts/check-brand-new.sh"}]' "$REPO_ROOT/.claude/settings.json" > "$FIX/.claude/settings.json"
expect_violation "足した hook を名指しする" "undeclared: check-brand-new.sh" "$FIX"

echo "=== scenario 4: 一覧から 1 本消すと落ちる ==="
make_fixture "$FIX"
jq 'del(.claudeOnly["verify-claims.sh"])' "$REPO_ROOT/scripts/lib/codex-hook-gap.json" > "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "消した hook を名指しする" "undeclared: verify-claims.sh" "$FIX"

echo "=== scenario 5: Codex に入った（または Claude から消えた）のに、一覧に残っていると落ちる ==="
make_fixture "$FIX"
jq '.claudeOnly["check-local-main-freshness.sh"] = {"category":"needs-rework","why":"テスト用"}' "$REPO_ROOT/scripts/lib/codex-hook-gap.json" > "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "両方に登録済みの hook が一覧にある" "stale-entry: check-local-main-freshness.sh" "$FIX"

echo "=== scenario 6: 入口の一覧から 1 本消すと落ちる ==="
make_fixture "$FIX"
grep -v '^check-e2e-freshness\.sh' "$REPO_ROOT/scripts/lib/codex-session-start-checks.txt" > "$FIX/scripts/lib/codex-session-start-checks.txt"
expect_violation "消した点検を名指しする" "entry-not-listed: check-e2e-freshness.sh" "$FIX"

echo "=== scenario 7: 扱いを決めていない点検を、入口の一覧に足すと落ちる ==="
make_fixture "$FIX"
echo "check-stale-worktrees.sh" >> "$FIX/scripts/lib/codex-session-start-checks.txt"
expect_violation "足した点検を名指しする" "listed-not-entry: check-stale-worktrees.sh" "$FIX"

echo "=== scenario 8: 区分の表に無い区分・理由の無い行は落ちる ==="
make_fixture "$FIX"
jq '.claudeOnly["verify-claims.sh"].category = "maybe-later"' "$REPO_ROOT/scripts/lib/codex-hook-gap.json" > "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "知らない区分を名指しする" "unknown-category: verify-claims.sh" "$FIX"
make_fixture "$FIX"
jq '.claudeOnly["verify-claims.sh"].why = "  "' "$REPO_ROOT/scripts/lib/codex-hook-gap.json" > "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "理由の無い行を名指しする" "no-reason: verify-claims.sh" "$FIX"

echo "=== scenario 9: 相方が Codex から外れると落ちる ==="
make_fixture "$FIX"
jq 'del(.hooks.Stop)' "$REPO_ROOT/.codex/hooks.json" > "$FIX/.codex/hooks.json"
expect_violation "相方の不在を名指しする" "missing-counterpart: ai-check-suggest.sh" "$FIX"
expect_violation "相方を失った hook は、扱いが決まっていない側に出る" "undeclared: ai-check-suggest.sh" "$FIX"

echo "=== scenario 10: 入口が Codex から外れると落ちる ==="
make_fixture "$FIX"
jq '.hooks.SessionStart[0].hooks |= map(select(.command | test("codex-session-start") | not))' "$REPO_ROOT/.codex/hooks.json" > "$FIX/.codex/hooks.json"
expect_violation "入口の不在を知らせる" "entry-unregistered:" "$FIX"

echo "=== scenario 11: 登録を 1 本も取り出せないときは、差を計算せずに落とす ==="
make_fixture "$FIX"
echo '{"hooks":{}}' > "$FIX/.codex/hooks.json"
expect_violation "Codex 側の空振りを知らせる" "empty-scan: .codex/hooks.json" "$FIX"
make_fixture "$FIX"
echo '{"hooks":{}}' > "$FIX/.claude/settings.json"
expect_violation "Claude 側の空振りを知らせる" "empty-scan: .claude/settings.json" "$FIX"

echo "=== scenario 12: 一覧そのものが無い・壊れているときは落ちる ==="
make_fixture "$FIX"
rm "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "一覧の不在を知らせる" "missing-file: scripts/lib/codex-hook-gap.json" "$FIX"
make_fixture "$FIX"
echo '{ 壊れた' > "$FIX/scripts/lib/codex-hook-gap.json"
expect_violation "壊れた一覧を知らせる" "broken-registry:" "$FIX"

echo "=== scenario 13: 区分ごとの本数（仕様書の数と同じ） ==="
COUNTS="$(jq -r '[.claudeOnly[].category] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' "$REPO_ROOT/scripts/lib/codex-hook-gap.json")"
echo "      ${COUNTS}"
TOTAL="$(jq '.claudeOnly | length' "$REPO_ROOT/scripts/lib/codex-hook-gap.json")"
ACTUAL_ONLY="$(check_gap "$REPO_ROOT" > /dev/null; wc -l < "$WORK/t/actual-gap" | tr -d ' ')"
[ "$TOTAL" = "$ACTUAL_ONLY" ] && ok "一覧の ${TOTAL} 本が、実登録から計算した差の本数と同じ" || ng "本数が合わない" "一覧 ${TOTAL} / 実登録の差 ${ACTUAL_ONLY}"

echo ""
echo "結果: ${pass} OK / ${fail} NG"
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
