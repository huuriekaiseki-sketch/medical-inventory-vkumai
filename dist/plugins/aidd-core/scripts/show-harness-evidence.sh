#!/usr/bin/env bash
# WHY(2026-09-10、レビューの設計提案 4): ハーネスの地図の状態欄は手書きの「あり / 一部」だった。
#      登録簿自身が「『あり』は中身の十分性を保証しない」と書いており、
#      **確かめようのない 1 語**が、事故のとき最初に開く 1 枚でいちばん目立つ場所に載っていた。
#
#      そこで宣言と実測を分けた。地図（コミットする文書）には**機械で実在を確かめられる宣言**だけを置き、
#      「いま測れているか」はここで実測の記録から出す。
#
#      3 つを潰さずに別々に出す（C-025）:
#        測定 … 記録が 1 行でもあるか（一度でも実際に回したか）
#        合格 … 直近の記録が pass か
#        最新 … 直近の記録が**いまの木**に対して取られたか
#
#      記録は機械ローカル（logs/ は git 管理外）なので、**コミットする文書へは焼き込まない**。
#      焼き込むと環境ごとに生成物が割れ、印が実態とずれる型（C-010）を作り直すことになる。
#
# 限界:
#   - 見るのは HEAD の木のハッシュだけで、**未コミットの書き換えは見ない**
#     （そちらは「終える瞬間に全件を通したか」を聞く Stop hook の担当。
#       同じ問いに 2 か所が別々に答えないようにする）
#   - 実測の記録を持たない役割は「持たない理由」を出すだけで、良し悪しは判定しない
#
# 実行: bash scripts/show-harness-evidence.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"

# 登録簿の探し方（プラグインとして導入されたときは、登録簿は**導入先のリポジトリ**にある。
# プラグイン内のパスを既定にすると、導入先の登録簿ではなく配布物側を見てしまう。
# render-harness-map.sh と同じ解決順）
resolve_registry() {
  if [ -n "${HARNESS_REGISTRY:-}" ]; then echo "$HARNESS_REGISTRY"; return; fi
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -f "$CLAUDE_PROJECT_DIR/scripts/lib/harness-registry.json" ]; then
    echo "$CLAUDE_PROJECT_DIR/scripts/lib/harness-registry.json"; return
  fi
  echo "$1/lib/harness-registry.json"
}
REGISTRY="$(resolve_registry "$SCRIPT_DIR")"

# 登録簿を持たない導入先では黙って通す（render-harness-map.sh と同じ扱い）
if [ ! -f "$REGISTRY" ]; then
  echo "harness-evidence: 登録簿がありません（${REGISTRY}）。対象 0 件で通します"
  exit 0
fi

exec node "$SCRIPT_DIR/lib/render-harness-map.mjs" "$REGISTRY" --root "$REPO_ROOT" --evidence
