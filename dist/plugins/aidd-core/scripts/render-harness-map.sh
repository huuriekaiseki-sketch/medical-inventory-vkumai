#!/usr/bin/env bash
# ハーネスの地図（docs/agents/harness-map.md）の表を登録簿から作り直す。
# 表を手で書くと数字が必ず古くなる（2026-09-09 に台帳の数字を 2 回取り違えた）。詳細は lib 側の WHY。
#
# 使い方:
#   bash scripts/render-harness-map.sh          # 書き出す
#   bash scripts/render-harness-map.sh --check   # 最新かだけ見る（CI・hooks-test）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 登録簿の探し方（プラグインとして導入されたときは、登録簿は**導入先のリポジトリ**にある。
# プラグイン内のパスを既定にすると、導入先の登録簿ではなく配布物側を見てしまう）
resolve_registry() {
  if [ -n "${HARNESS_REGISTRY:-}" ]; then echo "$HARNESS_REGISTRY"; return; fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/scripts/lib/harness-registry.json" ]; then
    echo "$CLAUDE_PROJECT_DIR/scripts/lib/harness-registry.json"; return
  fi
  echo "$1/lib/harness-registry.json"
}
REGISTRY="$(resolve_registry "$SCRIPT_DIR")"

# WHY(登録簿が無い導入先は黙って通す): エンジンは共通側（aidd-core）で配るが、
#      登録簿は導入先のもの。まだ地図を作っていないリポジトリで落とすと、
#      配っただけで赤くなる（check-detectors-effective.mjs と同じ扱い）。
if [ ! -f "$REGISTRY" ]; then
  echo "harness-map: 登録簿がありません（$REGISTRY）。対象 0 件で通します"
  exit 0
fi

exec node "$SCRIPT_DIR/lib/render-harness-map.mjs" "$REGISTRY" --root "$REPO_ROOT" "$@"
