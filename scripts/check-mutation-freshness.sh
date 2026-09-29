#!/usr/bin/env bash
set -uo pipefail

# WHY(2026-09-10): 製品コードの変異計測（Stryker）は**人が打たないと動かない**。
#      ハーネスの地図（harness-map.md）で「起動: 人」と書いていた 3 つのうちの 1 つ。
#      打ち忘れを自己申告に頼ると、統合テスト（E-030）・E2E（E-060）で起きたのと同じこと——
#      「いつからか分からないほど前から赤いまま」——が起こる。
#
#      SessionStart で直近の記録を見て、次のいずれかなら警告する（ブロックはしない）:
#        (a) 記録が 1 件も無い
#        (b) 直近が fail（下限を割った＝守っていないテストがある）
#        (c) 直近を記録したときから `src/` か **対象の一覧**（stryker.config.json）が変わっている
#        (d) 直近が未コミットの変更を含む状態での実行だった
#
#      (c) に設定ファイルを入れるのは、**対象を減らせばスコアが上がる**から。
#      `src/` が変わっていなくても一覧が変われば前の記録は当てにならない
#      （2026-09-08 に実際に対象を 10 → 12 ファイルへ広げて分母が変わっている）。
#
# WHY(判定は共有の engine): 統合テスト・E2E・RLS 変異とまったく同じ形。判定は
#      scripts/lib/run-freshness.py に置いてあり、ここが渡すのは「何を見張るか」「どう回すか」だけ。
#
# WHY(警告専用・jq 不在時は静かに終わる): 既存の check-*-freshness.sh と同じ設計。
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

LOG_FILE="$(resolve_log_dir)/mutation-runs.jsonl"

# WHY(設定が無ければ黙る): 変異の計測を導入していないリポジトリで
#      「一度も回していない」と言い続けても直しようがない
[ -f "$REPO_ROOT/stryker.config.json" ] || exit 0

SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"
CONFIG_TREE="$(git rev-parse "HEAD:stryker.config.json" 2>/dev/null || echo unknown)"
[ "$SRC_TREE" = "unknown" ] && exit 0

# WHY(C-041、2026-09-10): HEAD の木だけでは**未コミットの変更**が見えない。
#      記録側は最初から srcWorktree を残していたのに、判定側がそれを渡しておらず、
#      「認可の判断を手元で書き換えて、計測は前のまま」を素通りさせていた。
#      測る対象の一覧（stryker.config.json）も同じで、**手元で対象を減らせばスコアは上がる**。
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"
SRC_WORKTREE="$(worktree_hash src)"
CONFIG_WORKTREE="$(worktree_hash stryker.config.json)"

MSG="$(python3 "$SCRIPT_DIR/lib/run-freshness.py" \
  --log "$LOG_FILE" \
  --label "製品コードの変異計測" \
  --runner "bash scripts/run-mutation-tests.sh" \
  --tree "src=$SRC_TREE" \
  --tree "stryker=$CONFIG_TREE" \
  --worktree "src=$SRC_WORKTREE" \
  --worktree "stryker=$CONFIG_WORKTREE" \
  --changed-note "認可の判断が書かれた場所か、測る対象の一覧が動いたということなので、")"

[ -z "$MSG" ] && exit 0

jq -n --arg msg "$MSG" '{
  systemMessage: $msg,
  hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: $msg }
}'
