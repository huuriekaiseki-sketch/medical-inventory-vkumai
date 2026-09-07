#!/usr/bin/env bash
# WHY: 2026-09-07。統合テストが 2 件、**いつからか分からないほど前から赤いまま**放置されていた。
#      検知の仕組みが動いていなかったのではなく、「最後に全件を通したのはいつで、結果は何だったか」
#      を誰も記録していなかったので、誰も気づけなかった。
#      GitHub の CI が止まっている間、統合テストを回すのは人（またはエージェント）だけであり、
#      回したかどうかは自己申告に頼るしかない。せめて**回したときの結果は自己申告にしない**。
#
#      そこで実行そのものをここで包み、終了コードから結果を機械的に記録する。
#      「通ったことにする」ことはできない（記録するのは exit code であって主張ではない）。
#
#      記録は check-integration-freshness.sh（SessionStart hook）が読み、
#      「一度も無い」「前回が赤」「supabase/ が前回の記録から変わっている」のいずれかで警告する。
#
# 使い方: bash scripts/run-integration-tests.sh [追加の vitest 引数...]
#   実 DB が要る（supabase start 済み）。記録は logs/integration-runs.jsonl。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

cd "$REPO_ROOT" || exit 1

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/integration-runs.jsonl"

# WHY(npx を使わない): scripts/check-no-registry-fetch.test.sh が hook スクリプトの npx を禁止する
#      （2026-09-04 に CI が 4〜8 倍かかった原因）。node_modules のものを直接呼ぶ。
./node_modules/.bin/vitest run --config vitest.integration.config.ts "$@"
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  RESULT="pass"
else
  RESULT="fail"
fi

# supabase/ の木のハッシュを残す。次回、ここが変わっていれば「その記録はもう当てにならない」と分かる
# （コミット ID だと無関係な変更でも古く見え、日付だけだと変更に反応しない）
SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
DIRTY="false"
if ! git diff --quiet -- supabase 2>/dev/null; then DIRTY="true"; fi

python3 - "$LOG_FILE" "$RESULT" "$EXIT_CODE" "$SUPABASE_TREE" "$COMMIT" "$BRANCH" "$DIRTY" <<'PY'
import json, sys
from datetime import datetime, timezone

log_file, result, exit_code, tree, commit, branch, dirty = sys.argv[1:8]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": result,
    "exitCode": int(exit_code),
    "supabaseTree": tree,
    "commit": commit,
    "branch": branch,
    # 未コミットの変更がある状態での実行は「その木で通った」証拠にならない
    "supabaseDirty": dirty == "true",
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[run-integration-tests] {result} を記録しました: {log_file}")
PY

exit "$EXIT_CODE"
