#!/usr/bin/env bash
# 新しいルールブック（カタログ）の雛形を作り、登録簿へ足し、その場で検査まで回す。
#
# WHY: ルールブックは「同じ形の表 + 同じ検査」の繰り返しで、手で作ると必ず形がずれる
#      （列を 1 つ増やす・状態の語を変える・検査を書き忘れる）。増えるほど質がばらつくので、
#      雛形と登録を 1 コマンドにまとめる。作った直後に検査を回すところまでやるので、
#      「作ったが検査されていない」状態にならない。
#
# 使い方:
#   bash scripts/new-rulebook.sh \
#     --id partial-success \
#     --title "部分成功の棚卸し" \
#     --prefix M \
#     --columns "経路,途中で止まる形,利用者に見えること,再試行の約束,守るテスト" \
#     --states "原子的,収束する,中間状態あり,未確認" \
#     --evidence-states "原子的,収束する" \
#     --plan-states "中間状態あり,未確認" \
#     --issue 757
#
#   --columns は ID と 状態 を除いた中間の列（この順に並ぶ）。守るテスト列は末尾に置くこと。
#   --evidence-states はその状態なら守るテストのパスが要る。--plan-states は計画番号（#<issue>-N）が要る。
#   --dry-run で書き込まずに内容だけ出す。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# 登録簿の探し方（プラグインとして導入されたときは、登録簿は**導入先のリポジトリ**にある。
# プラグイン内のパスを既定にすると、導入先の登録簿ではなく配布物側を見てしまう）
resolve_registry() {
  if [ -n "${CATALOG_REGISTRY:-}" ]; then echo "$CATALOG_REGISTRY"; return; fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/scripts/lib/catalog-registry.json" ]; then
    echo "$CLAUDE_PROJECT_DIR/scripts/lib/catalog-registry.json"; return
  fi
  echo "$1/lib/catalog-registry.json"
}
REGISTRY="$(resolve_registry "$SCRIPT_DIR")"
DOCS_DIR="${RULEBOOK_DOCS_DIR:-$REPO_ROOT/docs/agents}"

id=""; title=""; prefix=""; columns=""; states=""; evidence_states=""; plan_states=""; issue="757"; dry_run=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id="$2"; shift 2 ;;
    --title) title="$2"; shift 2 ;;
    --prefix) prefix="$2"; shift 2 ;;
    --columns) columns="$2"; shift 2 ;;
    --states) states="$2"; shift 2 ;;
    --evidence-states) evidence_states="$2"; shift 2 ;;
    --plan-states) plan_states="$2"; shift 2 ;;
    --issue) issue="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

for required in id title prefix columns states; do
  if [ -z "${!required}" ]; then
    echo "new-rulebook: --${required//_/-} が要る（--help は使い方をこのファイルの先頭で）" >&2
    exit 2
  fi
done
if ! grep -qE '^[A-Z]$' <<<"$prefix"; then
  echo "new-rulebook: --prefix は英大文字 1 文字（例: M）" >&2
  exit 2
fi

FILE="docs/agents/${id}.md"
ABS="$DOCS_DIR/${id}.md"
if [ -e "$ABS" ] && [ "$dry_run" -eq 0 ]; then
  echo "new-rulebook: すでにある: $FILE" >&2
  exit 2
fi

# 雛形と登録簿エントリは node で作る（JSON の編集と列数の計算があるため）
node "$SCRIPT_DIR/lib/new-rulebook.mjs" \
  --id "$id" --title "$title" --prefix "$prefix" \
  --columns "$columns" --states "$states" \
  --evidence-states "$evidence_states" --plan-states "$plan_states" \
  --issue "$issue" --file "$FILE" --abs "$ABS" \
  --registry "$REGISTRY" --root "$REPO_ROOT" \
  ${dry_run:+$([ "$dry_run" -eq 1 ] && echo --dry-run)}

if [ "$dry_run" -eq 1 ]; then
  exit 0
fi

# 索引は生成物なので、登録した直後に作り直す（足したのに索引に無い状態を作らない）
CATALOG_REGISTRY="$REGISTRY" bash "$SCRIPT_DIR/render-rulebook-index.sh" > /dev/null

echo ""
echo "--- 作った直後の検査 ---"
# WHY(落ちてよい): 雛形は「限界」が仮置きなので、この時点では**必ず落ちる**のが正しい。
#      落ちたまま次の案内を出したいので、ここでは終了コードを見送る（set -e を効かせない）。
CATALOG_REGISTRY="$REGISTRY" bash "$SCRIPT_DIR/check-catalogs.test.sh" || true

echo ""
echo "次にやること（上の検査は雛形のままだと落ちる。それが正常）:"
echo "  1. $FILE の「一覧」に実際の行を書く（雛形の行は消す）"
echo "  2. 状態が「${evidence_states:-（守るテストが要る状態）}」の行には守るテストのパスを入れる"
echo "  3. $FILE の「## 限界」に、**この仕組みで見つからないこと**を書く"
echo "  4. 登録簿の limits（索引に出す 1 行）を書く: $REGISTRY"
echo "  5. bash scripts/render-rulebook-index.sh で索引を作り直す"
echo "  6. bash scripts/check-catalogs.test.sh で通ることを確かめる"
echo "  7. 共通側（他リポジトリ）へ配るなら scripts/lib/plugin-layout.json の checks を見直す"
