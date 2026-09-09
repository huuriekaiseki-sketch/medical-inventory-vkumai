#!/bin/bash
# WHY: docs/agents/check-design-pitfalls.md（検査の設計で間違えやすい型、C-xxx）の**中身**を固定する。
#      形（列数・ID・状態の語彙・守るテストの実在）は汎用エンジン（scripts/lib/check-catalog.mjs）が見るので、
#      ここで見るのはエンジンの範囲外にある「この表が腐る 3 つの形」だけ:
#
#   (a) 実例に日付が無い行を作らない。
#       この表は「実際に起きて実測した型」だけを載せる方針で、思いつきで増やすと読まれなくなる。
#       日付が書けない = 実例が無い = 思いつき、なので機械で止める
#   (b) 守るテストに自分自身（この表）を書かない。
#       自己言及で「検知あり」にできてしまうと、状態の語が意味を失う
#   (c) 状態が 検知なし の行は、ID を「## 限界」に名指しで残す。
#       検知が無い型こそ、限界として先に書いておかないと事故のとき最初に疑えない
#       （docs/agents/decisions.md「仕組みを作ったら見つからないことを先に書く」）
#   (d) 走査対象が少なすぎたら落とす（fail-open 防止）
#   (e) fixture で (a)〜(c) を検知できる（RED 方向の自己検証）
#
# 実行: bash scripts/check-pitfall-rulebook.test.sh
# 環境変数（テスト用注入ポイント）: PITFALL_RULEBOOK_PATH
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOC="${PITFALL_RULEBOOK_PATH:-$REPO_ROOT/docs/agents/check-design-pitfalls.md}"
MIN_ROWS=10

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

# 検査本体。$1=対象の文書。末尾行に violations=N
check_doc() {
  local doc="$1" violations=0 rows=0
  if [ ! -f "$doc" ]; then
    echo "    missing: $doc"
    echo "violations=1"
    return
  fi

  local limits
  limits="$(awk '/^## 限界/{f=1} f' "$doc")"

  local line id example tests status
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    rows=$((rows + 1))
    id="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$2); print $2}')"
    example="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$7); print $7}')"
    tests="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$8); print $8}')"
    status="$(printf '%s' "$line" | awk -F'|' '{gsub(/^ +| +$/,"",$9); print $9}')"

    # (a) 実例に日付（YYYY-MM-DD）がある
    if ! printf '%s' "$example" | grep -qE '[0-9]{4}-[0-9]{2}-[0-9]{2}'; then
      echo "    example: [$id] 実例に日付が無い（実際に起きたものだけを載せる）"
      violations=$((violations + 1))
    fi

    # (b) 守るテストが自分自身でない
    if printf '%s' "$tests" | grep -q 'check-design-pitfalls\.md'; then
      echo "    self: [$id] 守るテストがこの表自身を指している（自己言及で検知ありにできてしまう）"
      violations=$((violations + 1))
    fi

    # (c) 検知なし の行は「## 限界」に ID が名指しで出る
    if [ "$status" = "検知なし" ]; then
      if ! printf '%s' "$limits" | grep -q "$id"; then
        echo "    limits: [$id] 検知なしなのに「## 限界」で名指しされていない"
        violations=$((violations + 1))
      fi
    fi
  done < <(grep '^| C-' "$doc")

  # (d) fail-open 防止
  if [ "$rows" -lt "$MIN_ROWS" ]; then
    echo "    rows: 行が $rows 件しか読めない（表の読み取りが壊れている可能性）"
    violations=$((violations + 1))
  fi

  echo "violations=$violations"
}

echo "=== scenario 1: 実態の一覧に違反が無い ==="
OUT="$(check_doc "$DOC")"
N="$(printf '%s\n' "$OUT" | tail -1 | sed 's/violations=//')"
if [ "$N" = "0" ]; then
  assert_ok "違反なし（型 $(grep -c '^| C-' "$DOC") 件）"
else
  assert_fail "違反あり" "$(printf '%s\n' "$OUT")"
fi

echo "=== scenario 2: fixture で各違反を検知できる（RED 方向の自己検証） ==="
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
BAD="$TMP/bad.md"
{
  echo '# fixture'
  echo ''
  echo '| ID | 間違え方 | どう現れるか | なぜ気づけないか | 設計での無くし方 | 実例 | 守るテスト | 状態 |'
  echo '| --- | --- | --- | --- | --- | --- | --- | --- |'
  echo '| C-010 | あ | い | う | え | 日付の無い実例 | `package.json` | 検知あり |'
  echo '| C-020 | あ | い | う | え | 2026-09-09 の実例 | `docs/agents/check-design-pitfalls.md` | 検知あり |'
  echo '| C-030 | あ | い | う | え | 2026-09-09 の実例 | `package.json` | 検知なし |'
  echo ''
  echo '## 限界'
  echo ''
  # WHY: ここに ID を書いてしまうと「名指しされている」ことになり、fixture が自分で違反を消してしまう
  echo '（検知の無い型を名指ししていない限界の節）'
} > "$BAD"
OUT_BAD="$(check_doc "$BAD")"
printf '%s\n' "$OUT_BAD" | grep -q 'example: \[C-010\]' \
  && assert_ok "検知: 実例に日付が無い" || assert_fail "実例の日付欠落を検知できない" "$OUT_BAD"
printf '%s\n' "$OUT_BAD" | grep -q 'self: \[C-020\]' \
  && assert_ok "検知: 守るテストが自分自身" || assert_fail "自己言及を検知できない" "$OUT_BAD"
printf '%s\n' "$OUT_BAD" | grep -q 'limits: \[C-030\]' \
  && assert_ok "検知: 検知なしなのに限界で名指しされていない" || assert_fail "限界の名指し漏れを検知できない" "$OUT_BAD"
printf '%s\n' "$OUT_BAD" | grep -q 'rows: 行が 3 件' \
  && assert_ok "検知: 行が少なすぎる（fail-open 防止）" || assert_fail "行数の下限を検知できない" "$OUT_BAD"

echo "=== scenario 3: 正しい fixture は 1 件も出さない（誤検知しない） ==="
GOOD="$TMP/good.md"
{
  echo '# fixture'
  echo ''
  echo '| ID | 間違え方 | どう現れるか | なぜ気づけないか | 設計での無くし方 | 実例 | 守るテスト | 状態 |'
  echo '| --- | --- | --- | --- | --- | --- | --- | --- |'
  for i in 1 2 3 4 5 6 7 8 9 10; do
    echo "| C-0$i""0 | あ | い | う | え | 2026-09-09 に起きた | \`package.json\` | 検知あり |"
  done
  echo ''
  echo '## 限界'
} > "$GOOD"
OUT_GOOD="$(check_doc "$GOOD")"
[ "$(printf '%s\n' "$OUT_GOOD" | tail -1)" = "violations=0" ] \
  && assert_ok "誤検知なし" || assert_fail "正しい fixture で違反が出た" "$OUT_GOOD"

echo "=== scenario 4: 文書が無ければ落ちる（黙って通らない） ==="
OUT_MISSING="$(check_doc "$TMP/no-such-file.md")"
[ "$(printf '%s\n' "$OUT_MISSING" | tail -1)" = "violations=1" ] \
  && assert_ok "文書が無いことを検知" || assert_fail "文書が無くても通ってしまう" "$OUT_MISSING"

if [ "$fail" -ne 0 ]; then echo "FAILED"; exit 1; fi
echo "ALL PASSED"
