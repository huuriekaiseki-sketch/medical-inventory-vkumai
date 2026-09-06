#!/usr/bin/env bash
# ルールブックの索引（docs/agents/rulebooks.md）を登録簿から作り直す。
# 索引を手で書くと足し忘れ・消し忘れが必ず起きるので生成物にする（詳細は lib 側の WHY）。
#
# 使い方:
#   bash scripts/render-rulebook-index.sh          # 書き出す
#   bash scripts/render-rulebook-index.sh --check   # 最新かだけ見る（CI）
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
OUT="${RULEBOOK_INDEX:-docs/agents/rulebooks.md}"

exec node "$SCRIPT_DIR/lib/render-rulebook-index.mjs" "$REGISTRY" --out "$OUT" --root "$REPO_ROOT" "$@"
