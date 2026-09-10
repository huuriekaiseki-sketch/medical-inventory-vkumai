#!/bin/bash
# WHY: issue #731。sweep recall ベンチマーク（issue #431）の fixture コードに
#      「issue #431 の recall ベンチマーク用 fixture。○○を意図的に再現」という自己申告コメントが
#      あると、sweep エージェントが欠陥に気づいた上で「意図的な fixture」と判断して指摘から外し、
#      MISS になる（2026-09-05 実測: コメント有り 0/1 → 同じ定義・同じモデルでコメント無し 1/1）。
#      fixture の説明は各 case の NOTES.md（clone 先へコピーされない）に置き、`files/` 配下のコードには
#      正体を明かす語を書かないことを機械検査する。
#
# 実行: bash scripts/check-eval-fixtures-neutral.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_ROOT="${EVAL_FIXTURES_NEUTRAL_ROOT:-$SCRIPT_DIR/eval-fixtures}"

# clone 先へコピーされる files/ 配下に現れてはいけない語。
# 「fixture」「ベンチマーク」「意図的」「recall」「issue #431」「再現」は、コードを読む側に
# 「これは評価用の仕込みで、本物の欠陥ではない」と教えてしまう
# WHY(holdout を足した、2026-09-10): E-070 を直した**直後に**、自分が作った held-out fixture の
#      型名が `HoldoutNote` / `toHoldoutNote` のままだった——**「これは評価専用だ」と型名が言っている**。
#      機械も捕まえなかった。この一覧に `holdout` が無かったから。
#      「禁止語の一覧に載っている語しか見ない」という限界が、そのまま効いた形。
FORBIDDEN_PATTERN='fixture|ベンチマーク|benchmark|意図的|recall|issue #431|再現|eval-runs|known-failure-patterns|holdout|held-out'

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }

scan() {
  # $1: fixtures root。files/ 配下のソースだけを見る（NOTES.md・expected.json・manifest.json は対象外）。
  #
  # WHY(名前の除外をやめた、2026-09-10・E-070): ここには
  # 「ファイル名（eval-fixture-recall 等）は対象外。import パスや識別子として本文に必ず現れるため」
  # という除外があった。**その判断が実測で否定された。**
  # 回答本文を残すようにした 1 回目で、Sweep がこう書いていた——
  #   「eval_fixture_recall_items テーブルは eval フィクスチャ専用で本番対象外」
  # コードに自己申告を 1 文字も書いていなくても、**名前だけで伝わっていた**。
  # fixture の識別子・ファイル名・テーブル名を業務らしい名前へ変え（shift_handover_items 等）、
  # この除外そのものを外した。以後、名前に禁止語が入れば落ちる。
  find "$1" -path '*/files/*' -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' -o -name '*.js' \) -print0 \
    | xargs -0 grep -n -E -i "$FORBIDDEN_PATTERN" 2>/dev/null || true
}

# ファイル名・ディレクトリ名そのものに禁止語が入っていないか（本文とは別に見る）。
# WHY(相対パスにする): 走査の起点そのものが `scripts/eval-fixtures` なので、
#      絶対パスのまま見ると **すべての行が `fixture` に当たって全部違反**になる（最初そうなった）。
#      見たいのは fixture の**中**の名前なので、起点からの相対パスで判定する。
#
# WHY(判定は `files/` 以降だけ、2026-09-10): セット名（`sweep-db-holdout`）と case 名は
#      **clone にコピーされない**——Sweep が読むのは `files/` 配下だけ。
#      パス全体で見ると `*-holdout` のセットが丸ごと違反になる（`holdout` を禁止語に足した直後に踏んだ）。
#      表示は相対パス全体のまま（どこかを人が追えるように）、判定だけ `files/` 以降にする。
scan_names() {
  find "$1" -path '*/files/*' \( -type f -o -type d \) 2>/dev/null \
    | sed "s|^$1/||" \
    | awk -v pat="$FORBIDDEN_PATTERN" '{ p = tolower($0); sub(/^.*\/files\//, "", p); if (p ~ pat) print $0 }' || true
}

echo "=== scenario 1: 実態の fixture コードに自己申告語が無い ==="
HITS="$(scan "$FIXTURES_ROOT")"
if [ -z "$HITS" ]; then
  ok "files/ 配下に自己申告語なし（${FIXTURES_ROOT}）"
else
  ng "files/ 配下に自己申告語がある。説明は case ディレクトリの NOTES.md へ移すこと" "$HITS"
fi

echo "=== scenario 1b: ファイル名・ディレクトリ名も名乗っていない（E-070） ==="
# WHY(2026-09-10): 名前は本文に必ず現れるからと除外していたが、
#      **その名前を読んで Sweep が「評価用だから対象外」と指摘を外していた**（実測）。
NAME_HITS="$(scan_names "$FIXTURES_ROOT")"
if [ -z "$NAME_HITS" ]; then
  ok "files/ 配下の名前に自己申告語なし"
else
  ng "ファイル名・ディレクトリ名が評価用だと名乗っている（業務らしい名前に変えること）" "$NAME_HITS"
fi

echo "=== scenario 2: 各 case に NOTES.md がある（説明の置き場所を固定） ==="
for case_dir in "$FIXTURES_ROOT"/sweep-*/case-*/; do
  [ -d "$case_dir" ] || continue
  if [ -f "$case_dir/NOTES.md" ]; then
    ok "NOTES.md あり: $(basename "$(dirname "$case_dir")")/$(basename "$case_dir")"
  else
    ng "NOTES.md が無い: $case_dir"
  fi
done

echo "=== scenario 2b: expected.json の期待パスが files/ 配下に実在する（E-070 の改名で必要になった） ==="
# WHY(2026-09-10): 期待パスが実ファイルとずれると、**欠陥を見つけていても採点で MISS になる**——
#      測定そのものが静かに壊れる（合否だけ見ていると「モデルが劣化した」に見える）。
#      E-070 の改名は 18 ファイルに及んだので、1 つでもずれれば eval が嘘をつく。
#
# 1 行目に `COUNT=<走査した case 数>`、2 行目以降に「実在しなかった case」を出す。
#
# WHY(件数も標準出力に出す、2026-09-10): 最初は件数をグローバル変数に入れていたが、
#      呼び出しが `$(...)` の**サブシェル**なので親に伝わらず、常に 0 件になっていた。
#      **fail-open 防止（0 件なら落とす）を先に書いてあったから気づけた**——
#      それが無ければ「違反 0 件」で緑になり、この検査は何も見ないまま通り続けていた。
scan_expected_paths() { # $1 = fixtures root
  local case_dir needles found needle count=0 out=""
  for case_dir in "$1"/*/case-*/; do
    [ -f "${case_dir}expected.json" ] || continue
    count=$((count + 1))
    needles="$(jq -r '.expectedFilePathContains // empty | if type == "array" then .[] else . end' "${case_dir}expected.json" 2>/dev/null)"
    [ -n "$needles" ] || continue
    found=0
    while IFS= read -r needle; do
      [ -n "$needle" ] || continue
      if find "${case_dir}files" -type f 2>/dev/null | grep -qF -- "$needle"; then
        found=1
        break
      fi
    done <<< "$needles"
    if [ "$found" -eq 0 ]; then
      out="$out
  $(basename "$(dirname "$case_dir")")/$(basename "$case_dir"): $(printf '%s' "$needles" | tr '\n' ' ')"
    fi
  done
  echo "COUNT=$count"
  [ -n "$out" ] && printf '%s\n' "$out"
  return 0
}

PATHS_RESULT="$(scan_expected_paths "$FIXTURES_ROOT")"
EXPECTED_PATHS_CHECKED="$(printf '%s' "$PATHS_RESULT" | head -1 | sed 's/^COUNT=//')"
MISSING_PATHS="$(printf '%s' "$PATHS_RESULT" | tail -n +2)"
if [ "${EXPECTED_PATHS_CHECKED:-0}" -eq 0 ]; then
  ng "expected.json を持つ case が 1 つも無い（走査が壊れている）"
elif [ -z "$MISSING_PATHS" ]; then
  ok "全 ${EXPECTED_PATHS_CHECKED} case で期待パスが実在する"
else
  ng "期待パスが files/ 配下に無い（この case は永久に MISS になる）" "$MISSING_PATHS"
fi

echo "=== scenario 2c: 期待パスがずれていれば落ちる（RED 方向。改名で壊れる形） ==="
PATHWORK="$(mktemp -d)"
mkdir -p "$PATHWORK/sweep-x/case-1/files/src"
printf 'export const x = 1\n' > "$PATHWORK/sweep-x/case-1/files/src/shift-handovers.ts"
printf '{"expectedFilePathContains":"eval-fixture-recall.ts","expectedKeywords":["x"]}' > "$PATHWORK/sweep-x/case-1/expected.json"
RED_PATHS="$(scan_expected_paths "$PATHWORK" | tail -n +2)"
if [ -n "$RED_PATHS" ]; then
  ok "改名で置き去りになった期待パスを名指しする"
else
  ng "期待パスがずれていても見逃す（改名のたびに測定が静かに壊れる）"
fi
# 直せば通ることも対で見る（厳しくしすぎていない）
printf '{"expectedFilePathContains":"shift-handovers.ts","expectedKeywords":["x"]}' > "$PATHWORK/sweep-x/case-1/expected.json"
if [ -z "$(scan_expected_paths "$PATHWORK" | tail -n +2)" ]; then
  ok "期待パスを実ファイルに合わせれば通る（対照）"
else
  ng "正しい期待パスを誤検知した"
fi
# 走査そのものが動いていることも見る（COUNT が 0 なら上の 2 つは意味を持たない）
RED_COUNT="$(scan_expected_paths "$PATHWORK" | head -1 | sed 's/^COUNT=//')"
if [ "${RED_COUNT:-0}" -ge 1 ]; then
  ok "件数を数えている（サブシェルで 0 に化けない）"
else
  ng "件数が 0（走査が壊れている）"
fi
rm -rf "$PATHWORK"

echo "=== scenario 2d: fixture の import が実在する（E-073） ==="
# WHY(2026-09-10): fixture は clone の上に**上書き配置**され、Sweep は実コードの一部として読む。
#      `sweep-data-holdout` が存在しない `@/lib/security/facility-access` を import していたため、
#      Sweep は「そのモジュールは無い」と**正しく**指摘し、**仕込んだ欠陥は挙げなかった**。
#      壊れた import はそれ自体が目立つ欠陥なので、注意をそこへ吸い寄せる。
IMPORT_SCAN="$SCRIPT_DIR/lib/scan-fixture-imports.mjs"
# WHY(if で直接判定する、2026-09-10): このテストは `set -euo pipefail` で動く。
#      走査は違反があると非ゼロで返すので、素の `VAR="$(...)"` は代入ごと `set -e` に引っかかり、
#      **テストが途中で止まって残りの scenario が 1 つも走らない**（同じ罠を今日 3 回踏んだ）。
#      `if` の条件は `set -e` の免除対象なので、ここで判定してしまう
#      （`|| true` を足すと今度は終了コードが常に 0 になって判定が死ぬ）。
if IMPORT_OUT="$(FIXTURE_IMPORTS_ROOT="$FIXTURES_ROOT" FIXTURE_IMPORTS_SRC="$SCRIPT_DIR/../src" node "$IMPORT_SCAN" 2>&1)"; then
  ok "fixture の @/ import はすべて実在する"
else
  ng "fixture が存在しないモジュールを import している（仕込んだ欠陥を測れなくなる）" "$IMPORT_OUT"
fi
if printf '%s' "$IMPORT_OUT" | grep -q "imports=[1-9]"; then
  ok "import を実際に数えている（空振りでない）"
else
  ng "import が 0 件（走査が壊れている疑い）" "$IMPORT_OUT"
fi

echo "=== scenario 2e: 実在しない import は落ちる（RED 方向。E-073 の再現） ==="
IMPWORK="$(mktemp -d)"
mkdir -p "$IMPWORK/fx/sweep-x/case-1/files/src/app/api/thing" "$IMPWORK/src/lib/supabase"
printf 'export const requireAuth = () => {}\n' > "$IMPWORK/src/lib/supabase/require-auth.ts"
printf "import { requireAuth } from '@/lib/supabase/require-auth'\nexport const a = requireAuth\n" \
  > "$IMPWORK/fx/sweep-x/case-1/files/src/app/api/thing/route.ts"
if FIXTURE_IMPORTS_ROOT="$IMPWORK/fx" FIXTURE_IMPORTS_SRC="$IMPWORK/src" node "$IMPORT_SCAN" >/dev/null 2>&1; then
  ok "実在する import は通る（対照）"
else
  ng "実在する import を誤検知した"
fi
printf "import { x } from '@/lib/security/facility-access'\nexport const a = x\n" \
  > "$IMPWORK/fx/sweep-x/case-1/files/src/app/api/thing/route.ts"
RED_IMPORT="$(FIXTURE_IMPORTS_ROOT="$IMPWORK/fx" FIXTURE_IMPORTS_SRC="$IMPWORK/src" node "$IMPORT_SCAN" 2>&1 || true)"
if printf '%s' "$RED_IMPORT" | grep -q "missing-import"; then
  ok "存在しないモジュールへの import を名指しする"
else
  ng "壊れた import を見逃す（E-073 が再発する）" "$RED_IMPORT"
fi
# fixture 自身が置くモジュールは実在とみなす（過検知しない対照）
mkdir -p "$IMPWORK/fx/sweep-x/case-1/files/src/lib/shift-notes"
printf 'export const x = 1\n' > "$IMPWORK/fx/sweep-x/case-1/files/src/lib/shift-notes/helper.ts"
printf "import { x } from '@/lib/shift-notes/helper'\nexport const a = x\n" \
  > "$IMPWORK/fx/sweep-x/case-1/files/src/app/api/thing/route.ts"
if FIXTURE_IMPORTS_ROOT="$IMPWORK/fx" FIXTURE_IMPORTS_SRC="$IMPWORK/src" node "$IMPORT_SCAN" >/dev/null 2>&1; then
  ok "fixture が自分で置いたモジュールは実在とみなす"
else
  ng "fixture 自身のモジュールを誤検知した"
fi
rm -rf "$IMPWORK"

echo "=== scenario 3: 自己申告コメントを仕込むと検知する（RED 方向の自己検証） ==="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/sweep-x/case-1/files/src"
printf '// issue #431のrecallベンチマーク用fixture。認可チェック欠落を意図的に再現\nexport const x = 1\n' > "$WORK/sweep-x/case-1/files/src/a.ts"
RED_HITS="$(scan "$WORK")"
if [ -n "$RED_HITS" ]; then
  ok "仕込んだ自己申告コメントを検知"
else
  ng "自己申告コメントを検知できない（検査が空振り）"
fi

echo "=== scenario 4: 業務らしい名前なら通す（対照。厳しくしすぎていない） ==="
# WHY(2026-09-10・E-070): ここは以前「識別子・import パスとしての eval-fixture-recall は許容」
#      という**除外があること**を固定していた。その除外のせいで、Sweep が
#      「eval_fixture_recall_items は eval フィクスチャ専用で本番対象外」と判断して
#      指摘から外していた（実測）。除外を外したので、この scenario は逆向きに——
#      **業務らしい名前なら通る**ことを見る。
mkdir -p "$WORK/sweep-y/case-1/files/src"
printf "import type { Item } from '@/types/shift-handovers'\nexport const y = 1\n" > "$WORK/sweep-y/case-1/files/src/b.ts"
GREEN_HITS="$(scan "$WORK/sweep-y")"
if [ -z "$GREEN_HITS" ]; then
  ok "業務らしい名前の import は通る"
else
  ng "業務らしい名前を誤検知" "$GREEN_HITS"
fi

echo "=== scenario 4b: 名前で名乗る fixture は落ちる（RED 方向。E-070 の再現） ==="
printf "import type { Item } from '@/types/eval-fixture-recall'\nexport const w = 1\n" > "$WORK/sweep-y/case-1/files/src/d.ts"
if [ -n "$(scan "$WORK/sweep-y")" ]; then
  ok "識別子・パスが評価用だと名乗っていれば落ちる"
else
  ng "名前で名乗っていても見逃す（E-070 が再発する）"
fi
rm -f "$WORK/sweep-y/case-1/files/src/d.ts"

# ファイル名そのもので名乗る形も落ちること
mkdir -p "$WORK/sweep-z/case-1/files/src"
printf 'export const q = 1\n' > "$WORK/sweep-z/case-1/files/src/eval-fixture-thing.ts"
if [ -n "$(scan_names "$WORK/sweep-z")" ]; then
  ok "ファイル名で名乗っていれば落ちる"
else
  ng "ファイル名の自己申告を見逃す"
fi

# 素の自己申告語は今までどおり落ちる
printf "// これはベンチマーク用に意図的に再現した欠陥です\nexport const z = 1\n" > "$WORK/sweep-y/case-1/files/src/c.ts"
if [ -n "$(scan "$WORK/sweep-y")" ]; then
  ok "本文の自己申告語は今までどおり落ちる"
else
  ng "本文の自己申告語を見逃す"
fi
rm -f "$WORK/sweep-y/case-1/files/src/c.ts"

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
