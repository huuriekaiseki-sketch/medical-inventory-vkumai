#!/usr/bin/env bash
set -euo pipefail

# 変更ファイル一覧から「今回必須 / 今回不要（理由付き）」のテスト種別を機械導出する。
# 本体は scripts/lib/derive-test-selection.mjs（共通エンジン）と
# scripts/lib/derive-test-selection.rules.mjs（このリポジトリ固有のルール表）。
# このファイルは git diff を取って本体へ渡すだけの薄いラッパー。
#
# WHY: 引き継ぎメモ「04 どう確認したか」の「➖ 今回不要」の理由を人の記憶ではなく
#      機械が出す（kojigyo-zei-rag の同名スクリプトの vkumai 版。高リスクパス判定は
#      .claude/workflows/lib/router-risk.js の classifyRoute を正本とし、パス表を並行で持たない）。
#
# 使い方:
#   bash scripts/derive-test-selection.sh                          # git diff --name-only origin/main...HEAD
#   bash scripts/derive-test-selection.sh origin/main --format table   # 04 表に貼る形
#   bash scripts/derive-test-selection.sh --risk authz_change,retry_possible
#   printf 'a\nb\n' | bash scripts/derive-test-selection.sh --stdin   # 1行1パス
#   bash scripts/derive-test-selection.sh --files a,b --format table   # カンマ区切り（パイプ不要）
#   bash scripts/derive-test-selection.sh --list-keys                 # derive キー一覧（構造テスト用）
#
# 出力: JSON（既定）または Markdown 表（--format table）。未知の引数・リスクキーは exit 2。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/scripts/lib/derive-test-selection.mjs"

command -v node >/dev/null 2>&1 || { echo '{"error":"node is required"}'; exit 2; }
command -v git >/dev/null 2>&1 || { echo '{"error":"git is required"}'; exit 2; }

BASE=""
USE_STDIN=0
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stdin) USE_STDIN=1 ;;
    --files) USE_STDIN=1; PASS_ARGS+=("$1" "${2:-}"); shift ;;   # 1行1パスの代わりにカンマ区切りで渡す（パイプ不要）
    --format|--risk) PASS_ARGS+=("$1" "${2:-}"); shift ;;
    --list-keys|--list-rules|--list-risks|json|table) PASS_ARGS+=("$1") ;;
    --*) echo "{\"error\":\"unknown argument: $1\"}"; exit 2 ;;
    *) BASE="$1" ;;
  esac
  shift
done

# WHY: router-risk.js は package.json に "type":"module" が無い .js の ESM。Node 22.7+ は
#      構文検出で自動的に ESM 扱いするが、それ未満では --experimental-detect-module が要る。
#      CI の hooks-test ジョブは setup-node を使わず runner 既定の node に依存するため、
#      フラグを常に付けて版差を吸収する（24 系でも受理される）。警告は抑止する。
NODE_FLAGS=(--no-warnings --experimental-detect-module)

for a in "${PASS_ARGS[@]:-}"; do
  case "$a" in
    --list-keys|--list-rules|--list-risks) exec node "${NODE_FLAGS[@]}" "$ENGINE" "$a" ;;
  esac
done

if [ "$USE_STDIN" -eq 1 ]; then
  exec node "${NODE_FLAGS[@]}" "$ENGINE" "${PASS_ARGS[@]}"
fi

[ -n "$BASE" ] || BASE="origin/main"
git -C "$ROOT" diff --name-only "$BASE...HEAD" | node "${NODE_FLAGS[@]}" "$ENGINE" "${PASS_ARGS[@]}"
