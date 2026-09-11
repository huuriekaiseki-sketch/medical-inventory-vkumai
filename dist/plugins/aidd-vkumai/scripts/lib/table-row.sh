# Markdown の表の行を「列」に割る（shell 側の唯一の入口）。
#
# WHY(2026-09-11): 表の列の中にパイプを書きたいときは `\|` と書いてよい——という緩和を
#      2026-09-09 に入れた。共通エンジン（`scripts/lib/check-catalog.mjs` の `splitRow`）は
#      その約束を知っているが、**同じ表を自前の `awk -F'|'` で読む検査は知らないまま**だった。
#      実測（2026-09-11）: 表を自前で割っている 16 件のうち、緩和に追いついていたのは 6 件だけ。
#      残り 10 件は「いまその表に `\|` が無いから落ちていない」だけで、
#      誰かが 1 個書いた瞬間に**列が 1 つずれた値を黙って読む**（docs/agents/check-design-pitfalls.md の C-047）。
#
#      だから「エスケープに気づく割り方」を 1 か所に置き、shell 側はここだけを通す。
#      `splitRow` と同じ意味になるよう、セルの中身は `\|` のまま返す（落とさない・変えない）。
#
# 使い方:
#   source "$SCRIPT_DIR/lib/table-row.sh"
#   nf="$(table_nf "$line")"            # awk -F'|' から見た NF（= 列数 + 2）。素の awk と同じ数え方
#   id="$(table_field "$line" 2)"       # 2 列目（前後の空白を落とす）
#   table_mask_stream "$file" | awk -F'|' '...'   # ファイルごと awk へ渡すとき
#
# 限界:
#   - `\\|`（バックスラッシュ自体をエスケープした直後のパイプ）は区切りとして数えない。
#     `splitRow` の `(?<!\\)\|` も同じ扱いなので**両者の答えは一致する**が、
#     どちらも「本当は区切り」を取りこぼす。表にそう書かないこと（実例はまだ 1 件も無い）。
#   - 番人文字（U+0001）が元の行に入っていたら壊れる。Markdown の表に制御文字は書かない前提。

# 退避先。表の中に出てくることのない制御文字を使う
TABLE_ROW_SENTINEL=$'\001'

# `\|` を番人文字へ退避した行を返す（区切りの数え間違いを防ぐ）
table_mask() { printf '%s' "${1//\\|/$TABLE_ROW_SENTINEL}"; }

# 番人文字を `\|` へ戻す（セルの中身を人に見せる・比較する用）
table_unmask() { printf '%s' "${1//$TABLE_ROW_SENTINEL/\\|}"; }

# $1=行 → `awk -F'|'` の NF。**列数ではなく NF**（前後の空セルを含む）を返すのは、
# 置き換え前の検査がすべて NF で数えていて、そこを変えると条件式まで書き換わるから
table_nf() {
  awk -F'|' '{print NF}' <<<"$(table_mask "$1")"
}

# $1=行 $2=awk のフィールド番号（1 始まり。表の 1 列目は 2）→ そのセル（前後の空白を落とす）
table_field() {
  local cell
  cell="$(awk -F'|' -v n="$2" '{gsub(/^ +| +$/,"",$n); print $n}' <<<"$(table_mask "$1")")"
  table_unmask "$cell"
  printf '\n'
}

# ファイル（または標準入力）を流しながら `\|` を退避する。`awk -F'|' ... "$file"` の前に挟む
table_mask_stream() {
  sed "s/\\\\|/${TABLE_ROW_SENTINEL}/g" "$@"
}

# その逆。退避したまま人へ出さないための戻し
table_unmask_stream() {
  sed "s/${TABLE_ROW_SENTINEL}/\\\\|/g"
}
