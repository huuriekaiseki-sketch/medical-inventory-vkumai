#!/usr/bin/env bash
set -uo pipefail

# WHY: 2026-09-08（E-060）。E2E が 1 日以上、赤のまま誰にも見られていなかった。
#      `compat.spec.ts` は入口の検証が `quantity` を必須にした 2026-09-07 から落ち続けていたが、
#      **E2E は main マージ後にしか回らない**ので PR では誰も踏まなかった。
#      統合テストには鮮度を見る仕組み（check-integration-freshness.sh）があり、E2E には無かった。
#      E-030 と同じ型の穴が、別の場所にもう 1 つ空いていた。
#
#      SessionStart で、直近の記録（scripts/run-e2e-tests.sh が残す）を見て
#      次のいずれかなら警告する。ブロックはしない。
#        (a) 記録が 1 件も無い
#        (b) 直近が fail
#        (c) 直近を記録したときから `e2e/` か `src/` の中身が変わっている
#        (d) 直近が未コミットの変更を含む状態での実行だった
#
# WHY(src/ も見張る): E2E が守るのは画面の振る舞いなので、`src/` が動けば前回の結果は当てにならない。
#
# WHY(判定は共有の engine): scripts/lib/run-freshness.py。統合テスト版と同じ判定を使う。
#
# WHY(警告専用・jq 不在時は静かに終わる): ブロックしない hook なので、
#      jq が無い環境では警告が出ないだけにする（issue #636）。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/e2e-runs.jsonl"
E2E_TREE="$(git rev-parse "HEAD:e2e" 2>/dev/null || echo unknown)"
SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"

# e2e/ を持たないリポジトリ（プラグイン導入先など）では何も言わない
if [ "$E2E_TREE" = "unknown" ]; then
  exit 0
fi

MSG="$(python3 "$SCRIPT_DIR/lib/run-freshness.py" \
  --log "$LOG_FILE" \
  --label "E2E" \
  --runner "bash scripts/run-e2e-tests.sh" \
  --tree "e2e=$E2E_TREE" \
  --tree "src=$SRC_TREE" \
  --changed-note "画面かその spec が動いたということなので、")"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
