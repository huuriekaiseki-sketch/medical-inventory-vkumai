#!/usr/bin/env bash
# WHY(2026-09-10、レビューの設計提案 3): 精度を 1 つの数字にまとめると、性質の違う問いが
#      混ざって意味を失う。見逃し率（見つけられたか）と指摘の正確さ（出した指摘が正しいか）は
#      別の問いで、そこへ**測れなかった件数**を混ぜると、どちらも読めなくなる。
#
#      役割別に分けて、どれも 3 つを別々に出す:
#        分子       … 数えたいもの（倒した / 見つけた / 期待どおり返した）
#        分母       … **予定した件数**。測れなかった分をここから消さない
#        測れなかった … 実行エラー・対照が赤・判定していない
#
#      あわせて**同条件のばらつき**を出す。1 回の実行を合否に使うと、
#      モデルの揺れを仕組みの劣化と読み違える。実際 2026-09-10 に、
#      同じ fixture が 2/2 と 1/2 を行き来するのを実測した（それまで手で記録を掘るしか無かった）。
#
# 限界:
#   - 記録に残っている数字しか出せない。**費用・所要時間は記録していない**
#   - 見逃し率と指摘の正確さは「人が確定した既知欠陥の集合」が要るが、いまあるのは
#     Sweep の fixture（陽性 1 + 陰性 1）だけなので母数が小さい
#   - eval の記録は木のハッシュを持たないので、**ばらつきの間にコードが変わったかは分からない**
#
# 実行: bash scripts/show-precision-metrics.sh [--runs N]
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 登録簿の探し方（プラグインとして導入されたときは、登録簿は**導入先のリポジトリ**にある。
# プラグイン内のパスを既定にすると、導入先ではなく配布物側を見てしまう）
resolve_registry() {
  if [ -n "${PRECISION_METRICS_REGISTRY:-}" ]; then echo "$PRECISION_METRICS_REGISTRY"; return; fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/scripts/lib/precision-metrics.json" ]; then
    echo "$CLAUDE_PROJECT_DIR/scripts/lib/precision-metrics.json"; return
  fi
  echo "$1/lib/precision-metrics.json"
}
REGISTRY="$(resolve_registry "$SCRIPT_DIR")"

# 登録簿を持たない導入先では黙って通す
if [ ! -f "$REGISTRY" ]; then
  echo "precision-metrics: 登録簿がありません（${REGISTRY}）。対象 0 件で通します"
  exit 0
fi

exec node "$SCRIPT_DIR/lib/precision-metrics.mjs" "$REGISTRY" --root "$REPO_ROOT" "$@"
