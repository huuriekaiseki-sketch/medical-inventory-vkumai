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
# WHY(未コミット分も見る・2026-09-08): 以前は `<base>...HEAD` だけを見ていたので、
#      **コミット前に回すと変更ファイルが 0 件**になり、04 表が全部 ➖（今回不要）で出た。
#      エージェントは「書く → 検証 → コミット」の順で動くため、いちばん回したい時点で
#      いちばん誤解を招く出力になっていた。既定を
#      「<base>...HEAD ＋ ステージ済み ＋ 作業ツリー ＋ 未追跡」の和集合にする。
#      コミット済みだけを見たい場合（PR 本文の最終確認など）は --committed-only を付ける。
#      未追跡は gitignore 済みを除く（--exclude-standard）。
#
# 使い方:
#   bash scripts/derive-test-selection.sh                          # origin/main...HEAD ＋ 未コミット分
#   bash scripts/derive-test-selection.sh origin/main --format table   # 04 表に貼る形
#   bash scripts/derive-test-selection.sh --committed-only             # コミット済みだけ（旧挙動）
#   bash scripts/derive-test-selection.sh --risk authz_change,retry_possible
#   printf 'a\nb\n' | bash scripts/derive-test-selection.sh --stdin   # 1行1パス
#   bash scripts/derive-test-selection.sh --files a,b --format table   # カンマ区切り（パイプ不要）
#   bash scripts/derive-test-selection.sh --list-keys                 # derive キー一覧（構造テスト用）
#
# 出力: JSON（既定）または Markdown 表（--format table）。未知の引数・リスクキーは exit 2。
#
# 環境変数（テスト用注入ポイント）:
#   DTS_GIT_ROOT   変更ファイルを集めるリポジトリ（既定はこのリポジトリ）。
#                  エンジン本体の場所は変えない。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$ROOT/scripts/lib/derive-test-selection.mjs"
GIT_ROOT="${DTS_GIT_ROOT:-$ROOT}"

command -v node >/dev/null 2>&1 || { echo '{"error":"node is required"}'; exit 2; }
command -v git >/dev/null 2>&1 || { echo '{"error":"git is required"}'; exit 2; }

BASE=""
USE_STDIN=0
COMMITTED_ONLY=0
PASS_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --stdin) USE_STDIN=1 ;;
    --committed-only) COMMITTED_ONLY=1 ;;
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

# WHY: bash 3.2 は空配列の "${a[@]}" を set -u で unbound 扱いにする。"${a[@]:-}" だと
#      空文字が 1 個渡ってエンジンが「未知の引数」で exit 2 になるので、要素数で分岐する。
run_engine() {
  if [ "${#PASS_ARGS[@]}" -eq 0 ]; then
    node "${NODE_FLAGS[@]}" "$ENGINE"
  else
    node "${NODE_FLAGS[@]}" "$ENGINE" "${PASS_ARGS[@]}"
  fi
}

if [ "$USE_STDIN" -eq 1 ]; then
  run_engine
  exit $?
fi

[ -n "$BASE" ] || BASE="origin/main"

# WHY: 3 つの出所を集めて重複を潰す。base が解決できない環境（浅い clone 等）でも
#      未コミット分だけで動くよう、失敗した出所は黙って空として扱う。
collect_changed_files() {
  git -C "$GIT_ROOT" diff --name-only "$BASE...HEAD" 2>/dev/null || true
  if [ "$COMMITTED_ONLY" -eq 0 ]; then
    git -C "$GIT_ROOT" diff --name-only HEAD 2>/dev/null || true          # ステージ済み＋作業ツリー
    git -C "$GIT_ROOT" ls-files --others --exclude-standard 2>/dev/null || true  # 未追跡
  fi
}

collect_changed_files | sort -u | run_engine
