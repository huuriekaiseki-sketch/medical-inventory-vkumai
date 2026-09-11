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

if [ ! -f "$SCOPES" ]; then
  echo "層の宣言が見つかりません: ${SCOPES}"
  exit 2
fi
command -v node >/dev/null 2>&1 || { echo "node が無いので層の宣言を読めません"; exit 2; }

targets="$(node -e '
const fs = require("fs")
const scopes = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const want = new Set(process.argv[2].split(" "))
for (const [name, scope] of Object.entries(scopes.checks ?? {})) {
  if (want.has(scope)) console.log(name)
}
' "$SCOPES" "$WANT" 2>/dev/null)"

if [ -z "$targets" ]; then
  echo "回す対象が 1 本もありません（層の宣言が読めないか、その層が空）"
  exit 2
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  printf '%s\n' "$targets"
  exit 0
fi

pass=0
fail=0
missing=0
failed=""
while IFS= read -r name; do
  [ -n "$name" ] || continue
  script="$SCRIPTS_DIR/$name"
  if [ ! -f "$script" ]; then
    missing=$((missing + 1))
    failed="${failed}  見つからない: ${name}"$'\n'
    continue
  fi
  if (cd "$PROJECT_DIR" && CLAUDE_PROJECT_DIR="$PROJECT_DIR" bash "$script" > /dev/null 2>&1); then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    failed="${failed}  落ちた: ${name}"$'\n'
  fi
done <<< "$targets"

echo "導入先 ${PROJECT_DIR}: 合格 ${pass} / 失敗 ${fail} / 実体なし ${missing}"
if [ "$fail" -gt 0 ] || [ "$missing" -gt 0 ]; then
  echo "内訳（1 本ずつ bash で回すと理由が出ます）:"
  printf '%s' "$failed"
  exit 1
fi
exit 0
