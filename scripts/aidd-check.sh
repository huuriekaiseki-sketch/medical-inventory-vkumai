#!/usr/bin/env bash
# WHY(2026-09-12): 配っている検査には**導入先から回す入口が無かった**。
#      そのため誰も回さないか、回しても根が配布物側を向いていて**導入先を見ないまま緑**になっていた。
#      実測（導入先を模した 2 リポジトリ）: 導入先に違反を 4 つ置いても、反応した検査は 92 本中 1 本だけ。
#
#      入口をひとつ置き、**導入先のルートを明示して**、導入先を見る検査だけを回す。
#
# 何を回すか: 配布物に同梱された `scripts/lib/check-scopes.json`（生成物。正本は中心リポジトリの
#      `scripts/lib/plugin-layout.json` の `checkScopes`）が `consumer`（導入先だけを見る）または
#      `both`（自己検証と実態の走査が同居）と宣言した検査。`self`（配っているスクリプト自身の
#      単体テスト）は回さない——導入先の木とは関係が無いため。
#
# 限界（先に書く）:
#   - 層は人が書いた宣言。**中身が本当にその層かは機械で判定していない**
#   - `both` には、この製品の実データ（表名・閾値・色）を期待するものが残っている。
#     それらは導入先では必ず赤くなるので、順次「配らない」か「閾値を設定へ出す」へ動かす
#   - 実行系（jq / node / python3）が無ければ個々の検査が自分で降りる。ここでは止めない
#
# 使い方: aidd-check [--list] [--scope consumer|both|all]
# 終了コード: 0 = 全部通った / 1 = 落ちたものがある / 2 = 回す対象を 1 本も見つけられない
set -uo pipefail

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 配布物では bin/ と scripts/ が兄弟。中心リポジトリでは scripts/ 直下に置く
if [ -f "$BIN_DIR/lib/check-scopes.json" ]; then
  PLUGIN_ROOT="$(cd "$BIN_DIR/.." && pwd)"
  SCRIPTS_DIR="$BIN_DIR"
else
  PLUGIN_ROOT="$(cd "$BIN_DIR/.." && pwd)"
  SCRIPTS_DIR="$PLUGIN_ROOT/scripts"
fi
SCOPES="${AIDD_CHECK_SCOPES:-$SCRIPTS_DIR/lib/check-scopes.json}"

# 導入先のルート: CLAUDE_PROJECT_DIR → git のルート → いまの作業ディレクトリ
if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "${CLAUDE_PROJECT_DIR}" ]; then
  PROJECT_DIR="$CLAUDE_PROJECT_DIR"
elif PROJECT_DIR="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  :
else
  PROJECT_DIR="$PWD"
fi

WANT="consumer both"
LIST_ONLY=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --list) LIST_ONLY=1 ;;
    --scope)
      case "${2:-}" in
        consumer) WANT="consumer" ;;
        both) WANT="both" ;;
        all) WANT="consumer both self" ;;
        *) echo "--scope は consumer / both / all のいずれか" >&2; exit 2 ;;
      esac
      shift
      ;;
    *) echo "使い方: aidd-check [--list] [--scope consumer|both|all]" >&2; exit 2 ;;
  esac
  shift
done

# WHY(2026-09-12): 宣言（check-scopes.json）は**生成物にしか無い**ので、中心リポジトリで
#      この入口を回すと「層の宣言が見つかりません」で止まっていた。書いてある入口が動かない
#      形（E-085 と同じ）。正本は plugin-layout.json の checkScopes なので、そちらへ落ちる。
LAYOUT="$SCRIPTS_DIR/lib/plugin-layout.json"
if [ ! -f "$SCOPES" ] && [ ! -f "$LAYOUT" ]; then
  echo "層の宣言が見つかりません: ${SCOPES}（正本の ${LAYOUT} もありません）"
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "node が無いので層の宣言を読めません"; exit 2; }

targets="$(node -e '
const fs = require("fs")
const [scopesPath, layoutPath, wantRaw] = process.argv.slice(1)
// 生成物の宣言があればそれを、無ければ正本（plugin-layout.json の checkScopes）を読む
let checks
if (fs.existsSync(scopesPath)) {
  // 配布物: そのプラグインぶんだけ（実測 2026-09-12: aidd-core 29 本 / アダプター 7 本）
  checks = JSON.parse(fs.readFileSync(scopesPath, "utf8")).checks ?? {}
} else {
  // 中心リポジトリ: 正本から読む。ここは**両方のプラグインの元**なので合計 36 本になる。
  // 配布物 1 つより多いのは食い違いではなく正しい（29 + 7 = 36）。
  checks = JSON.parse(fs.readFileSync(layoutPath, "utf8")).checkScopes ?? {}
}
const want = new Set(wantRaw.split(" "))
for (const [name, scope] of Object.entries(checks)) {
  if (name.startsWith("_")) continue
  if (want.has(scope)) console.log(name)
}
' "$SCOPES" "$LAYOUT" "$WANT" 2>/dev/null)"

if [ -z "$targets" ]; then
  echo "回す対象が 1 本もありません（層の宣言が読めないか、その層が空）"
  exit 2
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '%s\n' "$targets"
  exit 0
fi

# WHY(2026-09-12): 以前は「合格 N / 失敗 M」しか出さず、**対象が無いので何もしなかった**ものを
#      合格に混ぜていた（C-025: 合否・検査不能・未実行を 1 つの真偽値に潰す）。
#      実測では、導入先で回る 29 本のうち実際に相手を見たのは 12〜13 本だけで、
#      残りは「持っていないので黙った」——なのに表示は「合格 29」だった。
#      配る検査は対象が無いとき出力に「対象なし」を含める決まりにし、ここで 4 値へ分ける。
pass=0
skipped=0
fail=0
missing=0
failed=""
skipped_list=""
# 「対象なし」と言った検査を比べる相手（空の木）。要るときだけ作る
EMPTY_ROOT=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  script="$SCRIPTS_DIR/$name"
  if [ ! -f "$script" ]; then
    missing=$((missing + 1))
    failed="${failed}  見つからない: ${name}"$'\n'
    continue
  fi
  out="$(cd "$PROJECT_DIR" && CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$script" 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    fail=$((fail + 1))
    failed="${failed}  落ちた: ${name}"$'\n'
  elif grep -q '対象なし' <<<"$out"; then
    # WHY(2026-09-12): 印は**場面ごと**に出るのに、分類は**検査ごと**なので粒度が合わない。
    #      導入先の .sh を実際に走査したうえで、別の場面で「対象なし」と言う検査があり、
    #      そのまま数えると丸ごと対象なしに倒れて**守りを過小に見せる**（実測: 13 本 → 7 本）。
    #      そこで「対象なし」と言ったものだけ、**空の木でもう一度回して出力を比べる**。
    #      変わらなければ本当に何も見ていない。変われば、この導入先の何かを見ている。
    if [ -z "$EMPTY_ROOT" ]; then
      EMPTY_ROOT="$(mktemp -d)"
      git init -q "$EMPTY_ROOT" 2>/dev/null || true
    fi
    out_empty="$(cd "$EMPTY_ROOT" && CLAUDE_PROJECT_DIR="$EMPTY_ROOT" bash "$script" 2>&1)"
    if [ "$(sed "s#${PROJECT_DIR}#<ROOT>#g" <<<"$out")" = "$(sed "s#${EMPTY_ROOT}#<ROOT>#g" <<<"$out_empty")" ]; then
      skipped=$((skipped + 1))
      skipped_list="${skipped_list}  対象なし: ${name}"$'\n'
    else
      pass=$((pass + 1))
    fi
  else
    pass=$((pass + 1))
  fi
done <<< "$targets"
[ -n "$EMPTY_ROOT" ] && rm -rf "$EMPTY_ROOT"

echo "導入先 ${PROJECT_DIR}: 見た ${pass} / 対象なし ${skipped} / 落ちた ${fail} / 実体なし ${missing}"
if [ "$skipped" -gt 0 ]; then
  echo "この導入先には対象が無いので何も見ていないもの（守られてはいません）:"
  printf '%s' "$skipped_list"
fi
if [ "$fail" -gt 0 ] || [ "$missing" -gt 0 ]; then
  echo "内訳（1 本ずつ bash で回すと理由が出ます）:"
  printf '%s' "$failed"
  exit 1
fi
exit 0
