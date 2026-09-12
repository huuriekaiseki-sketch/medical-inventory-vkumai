#!/bin/bash
# WHY: scripts/lib/table-row.sh（shell 側で表の行を列に割る唯一の入口）の回帰テスト。
#
#      守りたいのは 2 つ:
#        (1) `\|`（エスケープしたパイプ）を区切りとして数えない
#        (2) **共通エンジン（check-catalog.mjs の splitRow）と答えが一致する**
#      (2) が本命で、同じ表を 2 つの実装が読む以上、
#      「片方だけ規約の緩和を知っている」状態（C-047）が再発しないよう機械で留める。
#
#      対の実証として、素の `awk -F'|'` だと**その場でずれる**ことも測る
#      （直したことの証拠が「落ちないこと」だけだと、直っていなくても緑になる）。
#
# 実行: bash scripts/lib/table-row.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# WHY(2026-09-12): 配られると、この検査は配布物の中にある。`$SCRIPT_DIR/../..` を使うと
#      **プラグイン自身**を走査する（E-086・E-087）。
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  REPO_ROOT="$CLAUDE_PROJECT_DIR"
else
  REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
fi
source "$SCRIPT_DIR/table-row.sh"

fail=0
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else echo "  NG: $3 (expected=[$2] actual=[$1])"; fail=1; fi
}
assert_ne() {
  if [ "$1" != "$2" ]; then echo "  OK: $3"; else echo "  NG: $3 (どちらも [$1] で、差が出ていない)"; fail=1; fi
}

ROW='| F-001 | a \| b | c | d |'

echo "=== scenario 1: エスケープしたパイプを区切りとして数えない ==="
assert_eq "$(table_nf "$ROW")" "6" "NF は 6（4 列 + 前後の空セル）"
assert_ne "$(awk -F'|' '{print NF}' <<<"$ROW")" "6" "素の awk は違う数を返す（対の実証）"

echo "=== scenario 2: セルの中身は \\| のまま返る（落とさない・変えない） ==="
assert_eq "$(table_field "$ROW" 2)" "F-001" "1 列目"
assert_eq "$(table_field "$ROW" 3)" 'a \| b' "2 列目はエスケープを保ったまま"
assert_eq "$(table_field "$ROW" 4)" "c" "3 列目が 1 つずれていない"
assert_ne "$(awk -F'|' '{gsub(/^ +| +$/,"",$4); print $4}' <<<"$ROW")" "c" "素の awk は 3 列目を取り違える（対の実証）"

echo "=== scenario 3: 共通エンジン（splitRow）と答えが一致する ==="
# WHY(表の名前を焼き込まない。C-048): エスケープを実際に含む表は導入先ごとに違う。
#      あるものを使い、1 つも無い導入先では見本を作って同じ突合をする
#      （「1 つも無いから飛ばす」にすると、いちばん大事な突合が黙って消える）
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

DOC=""
if [ -d "$REPO_ROOT/docs" ]; then
  for d in $(grep -rl -F '\|' "$REPO_ROOT/docs" --include='*.md' 2>/dev/null || true); do
    # エスケープが**表の行の中**にあるものだけを選ぶ（本文中の `\|` では突合にならない）
    if grep -qE '^\|.*\\\|' "$d"; then DOC="$d"; break; fi
  done
fi
if [ -n "$DOC" ]; then
  SOURCE_LABEL="実物の表（${DOC#"$REPO_ROOT"/}）"
else
  DOC="$WORK/fixture.md"
  {
    echo '| ID | 中身 | 状態 |'
    echo '| --- | --- | --- |'
    echo '| X-001 | a \| b | 実装済み |'
    echo '| X-002 | ふつうの行 | 実装済み |'
    echo '| X-003 | \| で始まる | 未 |'
  } > "$DOC"
  # WHY(2026-09-12): 突合そのものは必ずやる（対象が無くても見本で測る）が、
  #      **この導入先の表は見ていない**ことは呼ぶ側（aidd-check）に伝わる必要がある。
  #      印の語「対象なし」を含めて、合格と混ぜられないようにする（C-025）。
  SOURCE_LABEL="見本の表（対象なし: この導入先の docs にエスケープを含む表がまだ無い）"
fi

# 突合する行をここで 1 度だけ選ぶ（両側に同じ入力を渡すため。選び方が 2 つあると差が出ても原因が割れる）。
# 表の行 = `|` で始まり、区切り行（`| --- |`）ではないもの
ROWS="$WORK/rows.txt"
grep -E '^\|' "$DOC" | grep -vE '^\|[[:space:]|:-]+$' > "$ROWS"
ESC_ROWS="$(grep -c -F '\|' "$ROWS" || true)"

if [ ! -s "$ROWS" ] || [ "$ESC_ROWS" -eq 0 ]; then
  # WHY(C-044): エスケープが 1 つも無い入力で突合しても「両方が素の split でも通る」ため、
  #      一致の証明にならない。走査の故障として落とす
  echo "  NG: 突合の対象（表の行 $(wc -l < "$ROWS" | tr -d ' ') 件・うちエスケープ ${ESC_ROWS} 件）が足りない"
  fail=1
else
  BY_SHELL="$WORK/by-shell.txt"
  BY_ENGINE="$WORK/by-engine.txt"

  while IFS= read -r line; do
    nf="$(table_nf "$line")"
    out="$((nf - 2))"
    i=2
    while [ "$i" -le "$((nf - 1))" ]; do
      out="$out	$(table_field "$line" "$i")"
      i=$((i + 1))
    done
    printf '%s\n' "$out"
  done < "$ROWS" > "$BY_SHELL"

  node -e '
    const { readFileSync } = require("node:fs")
    const [rows, engine] = process.argv.slice(1)
    import(`file://${engine}`).then(({ splitRow }) => {
      const out = []
      for (const line of readFileSync(rows, "utf8").split("\n")) {
        if (line === "") continue
        const cells = splitRow(line)
        out.push([String(cells.length), ...cells].join("\t"))
      }
      process.stdout.write(out.join("\n") + "\n")
    })
  ' "$ROWS" "$SCRIPT_DIR/check-catalog.mjs" > "$BY_ENGINE"

  if diff -u "$BY_ENGINE" "$BY_SHELL" > /dev/null; then
    echo "  OK: ${SOURCE_LABEL} の全 $(wc -l < "$ROWS" | tr -d ' ') 行（うち ${ESC_ROWS} 行にエスケープ）で、列数と中身が一致する"
  else
    echo "  NG: 共通エンジンと答えが違う"
    diff -u "$BY_ENGINE" "$BY_SHELL" | head -20
    fail=1
  fi
fi

echo "=== scenario 4: ファイルごと awk へ渡す経路でも区切りを数え違えない ==="
printf '%s\n' '| X-001 | p \| q | r |' '| X-002 | s | t |' > "$WORK/t.md"
MASKED_NF="$(table_mask_stream "$WORK/t.md" | awk -F'|' '{print NF}' | sort -u | tr '\n' ',')"
assert_eq "$MASKED_NF" "5," "どの行も NF=5（退避してから割る）"
RAW_NF="$(awk -F'|' '{print NF}' "$WORK/t.md" | sort -u | tr '\n' ',')"
assert_ne "$RAW_NF" "5," "退避しないと行によって NF が変わる（対の実証）"
BACK="$(printf '%s' "p ${TABLE_ROW_SENTINEL} q" | table_unmask_stream)"
assert_eq "$BACK" 'p \| q' "退避した文字は元へ戻せる"

if [ "$fail" -eq 0 ]; then
  echo "table-row: すべて OK"
else
  echo "table-row: 失敗あり"
fi
exit "$fail"
