#!/usr/bin/env bash
# WHY(2026-09-10、レビュー指摘 R11): Sweep の recall を測る採点器が、
#      **「問題ありません」という回答も成功（HIT）にしていた**。
#      判定が「期待ファイルパスの部分文字列 AND 期待キーワード」だけだったので、
#      欠陥を見逃した回答でも、その語を口にしていれば当たったことになる。
#      2026-09-10 の実測では、陰性の回答も陽性の回答もどちらも true だった。
#
#      recall（見つけられた割合）を測っているつもりで「その語を口にしたか」を測っていた。
#      採点器が甘いと、Sweep の劣化が数字に出ない——**測っていることが測りたいことと違う**型。
#
#      ここでは LLM を呼ばずに、採点器そのものを固定する:
#        - 陽性（欠陥を指摘した回答）は HIT
#        - 陰性（問題なしと答えた回答）は MISS ← 直す前はここが HIT だった
#        - 無関係な回答は MISS
#        - 陰性対照の fixture（expectNoFinding）は逆向きに採点する
#
# 実行: bash scripts/lib/judge-sweep-recall.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUDGE="$SCRIPT_DIR/judge-sweep-recall.py"

fail=0
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/expected.json" <<'JSON'
{
  "expectedFilePathContains": "eval-fixture-recall/[id]/route.ts",
  "expectedKeywords": ["requireAuth", "認証", "認可"]
}
JSON

cat > "$WORK/expected-negative.json" <<'JSON'
{
  "expectedFilePathContains": "eval-fixture-recall/[id]/route.ts",
  "expectedKeywords": ["requireAuth", "認証", "認可"],
  "expectNoFinding": true
}
JSON

judge() { # $1=expected.json, $2=detail の中身 → 標準出力に true/false
  printf '%s' "$2" > "$WORK/detail.txt"
  EXPECTED_FILE="$1" DETAIL_FILE="$WORK/detail.txt" python3 "$JUDGE"
}

assert_judge() { # $1=expected.json, $2=detail, $3=期待, $4=ラベル
  local got
  got="$(judge "$1" "$2")"
  if [ "$got" = "$3" ]; then
    echo "  OK: $4"
  else
    echo "  NG: ${4}（期待 ${3} / 実際 ${got}）"
    fail=1
  fi
}

POSITIVE='FINDINGS: 1
app/api/eval-fixture-recall/[id]/route.ts で requireAuth を呼んでおらず、認可チェックが抜けています。'

NEGATIVE='FINDINGS: 0
調査しました。app/api/eval-fixture-recall/[id]/route.ts を確認しましたが、
認証・認可に問題はありません。requireAuth も適切に呼ばれています。指摘なし。'

NEGATIVE_NO_HEADER='調査しました。app/api/eval-fixture-recall/[id]/route.ts を確認しましたが、
認証・認可に問題はありません。requireAuth も適切に呼ばれています。指摘なし。'

UNRELATED='FINDINGS: 1
まったく関係のない話です。天気は晴れです。'

POSITIVE_NO_HEADER='app/api/eval-fixture-recall/[id]/route.ts で requireAuth を呼んでおらず、認可チェックが抜けています。'

echo "=== scenario 1: 陽性（欠陥を指摘した回答）は HIT ==="
assert_judge "$WORK/expected.json" "$POSITIVE" "true" "件数付きの指摘は HIT"
assert_judge "$WORK/expected.json" "$POSITIVE_NO_HEADER" "true" "件数の行が無くても、指摘なしと書いていなければ HIT"

echo "=== scenario 2: 陰性（問題なしという回答）は MISS（直す前はここが HIT） ==="
assert_judge "$WORK/expected.json" "$NEGATIVE" "false" "FINDINGS: 0 は HIT にしない"
assert_judge "$WORK/expected.json" "$NEGATIVE_NO_HEADER" "false" "件数の行が無くても「指摘なし」は HIT にしない"

echo "=== scenario 3: 無関係な回答は MISS（従来どおり） ==="
assert_judge "$WORK/expected.json" "$UNRELATED" "false" "パスもキーワードも無ければ MISS"

echo "=== scenario 4: 陰性対照の fixture は逆向きに採点する ==="
assert_judge "$WORK/expected-negative.json" "$NEGATIVE" "true" "欠陥の無い fixture で何も指摘しなければ HIT"
assert_judge "$WORK/expected-negative.json" "$POSITIVE" "false" "欠陥の無い fixture について指摘を出したら MISS（過検出）"

echo "=== scenario 4b: 陰性対照は「他のファイルへの指摘」では落ちない ==="
# WHY(2026-09-10 実測): sweep はコードベース全体を調べるので、無関係な実コードについて
#      指摘を出すのが普通。「指摘 0 件」を条件にすると同じ fixture が実行のたびに
#      HIT と MISS を行き来した（2/2 → 1/2 → 2/2）。**flaky な評価は無いより悪い。**
OTHER_FINDING='FINDINGS: 3
src/lib/orders/repository.ts で N+1 クエリが発生しています。
src/components/orders/OrderHistoryTable.tsx の key が index です。
db/migrations/20260101_x.sql に索引がありません。'
assert_judge "$WORK/expected-negative.json" "$OTHER_FINDING" "true" "他のファイルへの指摘は過検出に数えない"
assert_judge "$WORK/expected.json" "$OTHER_FINDING" "false" "陽性側でも、他のファイルへの指摘は HIT にしない（対称）"

echo "=== scenario 4c: 層ごとの「指摘なし」を全体の 0 件と読まない ==="
# WHY(2026-09-10 実測): sweep の報告は層ごとに並び、「A 層は指摘なし」と書きながら
#      B 層の欠陥を挙げるのが普通の形。本文全体から語を探すと、1 件でも指摘している報告を
#      0 件と読み違える（JSON が返らず生出力へ落ちた回に、陽性の case が実際に MISS した）。
#      契約の件数の行が無いときは、総括が置かれる**最初か最後の非空行**だけを見る。
MIXED='【データ取得層】指摘なし。
【APIルート】app/api/eval-fixture-recall/[id]/route.ts で requireAuth を呼んでおらず、認可チェックが抜けています。'
assert_judge "$WORK/expected.json" "$MIXED" "true" "本文の途中の「指摘なし」で 0 件と読まない"
assert_judge "$WORK/expected-negative.json" "$MIXED" "false" "陰性対照では同じ報告を過検出として扱う（対称）"

echo "=== scenario 5: 件数が読めず言い回しも契約外なら「指摘あり」側に倒す ==="
# 判定できないことを理由に recall を下げると、採点器の壊れがモデルの劣化に見える
assert_judge "$WORK/expected.json" 'app/api/eval-fixture-recall/[id]/route.ts の認可について所感を述べます。' "true" "判定できないときは指摘ありとして扱う"

echo "=== scenario 6: 全角コロン・大文字小文字の揺れを吸収する ==="
assert_judge "$WORK/expected.json" 'findings：0
route.ts の認可は問題ありません' "false" "findings：0 も 0 件として読む"

echo "=== scenario 7: パスとキーワードが別々の指摘に分かれていたら HIT にしない（R11 の後段） ==="
# WHY(2026-09-10): Sweep はリポジトリ全体を掃くので、**この fixture とは無関係な指摘**が
#      何件も並ぶのが普通。本文全体で「パスがある AND キーワードがある」を見ていたので、
#      2 つの別々の指摘にまたがっていても HIT になっていた（＝欠陥を外していても満点）。
SPLIT_FINDINGS='FINDINGS: 2
1. app/api/eval-fixture-recall/[id]/route.ts のレスポンス型が統一されていません
2. src/lib/other/service.ts で requireAuth の呼び出し順序が読みにくいです'
assert_judge "$WORK/expected.json" "$SPLIT_FINDINGS" "false" "別々の指摘に分散していたら MISS"

SAME_FINDING='FINDINGS: 2
1. src/lib/other/service.ts のログ出力が冗長です
2. app/api/eval-fixture-recall/[id]/route.ts で requireAuth を呼んでいません'
assert_judge "$WORK/expected.json" "$SAME_FINDING" "true" "同じ指摘の中でそろっていれば HIT（対照）"

# 1 つの指摘が入れ子の箇条書きで続く形（実際の sweep 出力でいちばん多い）。
# ここを切ってしまうと 1 件が分断されて、実際より recall が低く出る
NESTED='FINDINGS: 1
1. **認可チェックの欠落**
   - ファイル: app/api/eval-fixture-recall/[id]/route.ts
   - 問題: requireAuth を呼んでいないため、未認証でも取得できます'
assert_judge "$WORK/expected.json" "$NESTED" "true" "入れ子の箇条書きは 1 つの指摘として扱う（分断しない）"

# 見出しで区切る書き方も、別の指摘として切る
HEADINGS='FINDINGS: 2
## app/api/eval-fixture-recall/[id]/route.ts
レスポンスの形が他と揃っていません。

## src/lib/other/service.ts
requireAuth の呼び出しが読みにくいです。'
assert_judge "$WORK/expected.json" "$HEADINGS" "false" "見出しで分かれた別の指摘も分散として扱う"

echo "=== scenario 7b: 陰性対照も同じ切り方で見る（他ファイルへの指摘で落ちない） ==="
assert_judge "$WORK/expected-negative.json" "$SPLIT_FINDINGS" "true" "分散した指摘は陰性対照を落とさない"
assert_judge "$WORK/expected-negative.json" "$SAME_FINDING" "false" "その fixture を名指しした指摘は陰性対照で MISS"

echo "=== scenario 7c: --loose は従来どおり本文全体で見る（切り替えの影響を測る記録用） ==="
judge_loose() {
  printf '%s' "$2" > "$WORK/detail-loose.txt"
  EXPECTED_FILE="$1" DETAIL_FILE="$WORK/detail-loose.txt" python3 "$JUDGE" --loose
}
got_loose="$(judge_loose "$WORK/expected.json" "$SPLIT_FINDINGS")"
if [ "$got_loose" = "true" ]; then
  echo "  OK: 従来の判定では分散していても HIT になる（この差が R11 そのもの）"
else
  echo "  NG: --loose が従来の挙動を再現していない（実際 ${got_loose}）"
  fail=1
fi
got_loose2="$(judge_loose "$WORK/expected.json" "$NEGATIVE")"
if [ "$got_loose2" = "false" ]; then
  echo "  OK: --loose でも「指摘なし」は HIT にしない（そこは前に直した）"
else
  echo "  NG: --loose が「指摘なし」を HIT にした（実際 ${got_loose2}）"
  fail=1
fi

echo "=== scenario 7d: 期待語を並べただけでファイルを名指ししなければ MISS ==="
# WHY(2026-09-10・R11 の追加テスト): 「認証・認可の扱いに注意が必要」のような**総括**は、
#      指摘としては何も特定していない。同じ指摘の中で見る判定なら自然に落ちるが、
#      **落ちることを固定する**（判定を戻したときに気づけるように）
KEYWORDS_ONLY='FINDINGS: 1
1. 全体として requireAuth と認可の扱いに注意が必要です'
assert_judge "$WORK/expected.json" "$KEYWORDS_ONLY" "false" "語だけ並べた総括は HIT にしない"

echo "=== scenario 7e: 同じ型の欠陥を別ファイルで指摘していたら MISS（囮） ==="
# WHY: fixture には囮（同じ型の欠陥を持つ別ファイル）を置いた case がある
#      （sweep-ui/case-2-late-suspense-after-decoy）。囮だけを指摘して本命を外した回を
#      HIT と読むと、**囮に引っかかったことが recall に現れない**
DECOY_ONLY='FINDINGS: 1
1. app/api/other-feature/[id]/route.ts で requireAuth を呼んでおらず、認可チェックが抜けています'
assert_judge "$WORK/expected.json" "$DECOY_ONLY" "false" "囮だけの指摘は HIT にしない"

DECOY_AND_REAL='FINDINGS: 2
1. app/api/other-feature/[id]/route.ts で requireAuth を呼んでいません
2. app/api/eval-fixture-recall/[id]/route.ts でも requireAuth を呼んでいません'
assert_judge "$WORK/expected.json" "$DECOY_AND_REAL" "true" "囮と本命の両方を挙げていれば HIT（対照）"

echo "=== 指摘の件数を返す（--count。実コードへの指摘の多さを追うため） ==="
# WHY(2026-09-10): 陰性対照は「その fixture への指摘」しか数えないので、
#      **実在ファイルへの誤指摘が 0 件として素通り**していた。
#      Sweep は毎回リポジトリ全体を掃くので、件数を残せば増減を追える。
#      **本物か誤りかは分けない**（人が見る）。0 と「読めなかった」を混ぜない。
count_of() {
  printf '%s' "$1" > "$WORK/count-detail.txt"
  DETAIL_FILE="$WORK/count-detail.txt" python3 "$JUDGE" --count
}
assert_eq() {
  if [ "$1" = "$2" ]; then echo "  OK: $3"; else echo "  NG: $3（期待 $2 / 実際 $1）"; fail=1; fi
}
assert_eq "$(count_of 'FINDINGS: 3
- a
- b
- c')" "3" "契約どおりの件数を返す"
assert_eq "$(count_of 'FINDINGS: 0
指摘なし')" "0" "0 件は 0 と返す"
assert_eq "$(count_of 'いろいろ調べました
指摘なし。')" "0" "契約が無くても、締めが「指摘なし」なら 0"
assert_eq "$(count_of '調べました
- src/x.ts: 何か問題')" "-1" "件数が読めなければ -1（0 と混ぜない）"
assert_eq "$(count_of '')" "-1" "空も -1"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
