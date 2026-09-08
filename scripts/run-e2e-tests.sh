#!/usr/bin/env bash
# WHY: 2026-09-08（E-060）。E2E が 1 日以上、赤のまま誰にも見られていなかった。
#      `compat.spec.ts` は入口の検証が `quantity` を必須にした 2026-09-07 から落ち続けていたが、
#      **E2E は main マージ後にしか回らない**（2026-08-25 に Actions 無料枠の都合で PR 実行を廃止）ので
#      PR では誰も踏まなかった。統合テストには鮮度を見る仕組みがあり、E2E には無かった。
#
#      そこで実行そのものをここで包み、終了コードから結果を機械的に記録する。
#      「通ったことにする」ことはできない（記録するのは exit code であって主張ではない）。
#
#      記録は check-e2e-freshness.sh（SessionStart hook）が読み、
#      「一度も無い」「前回が赤」「前回の記録から `e2e/` か `src/` が変わっている」のいずれかで警告する。
#
# WHY(src/ も見張る): E2E が守るのは画面の振る舞いなので、`src/` が動けば前回の結果は当てにならない。
#      `e2e/` だけを見ると、プロダクトコードを変えたのに「前回通ったから大丈夫」と読めてしまう。
#
# 使い方: bash scripts/run-e2e-tests.sh [追加の playwright 引数...]
#   実 DB と dev サーバーが要る（playwright.config.ts の webServer が起動する）。
#   記録は logs/e2e-runs.jsonl。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

cd "$REPO_ROOT" || exit 1

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/e2e-runs.jsonl"

# WHY(npx を使わない): scripts/check-no-registry-fetch.test.sh が hook スクリプトの npx を禁止する
#      （2026-09-04 に CI が 4〜8 倍かかった原因）。node_modules のものを直接呼ぶ。
./node_modules/.bin/playwright test "$@"
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  RESULT="pass"
else
  RESULT="fail"
fi

# WHY(部分実行は記録しない): `--grep` や spec 名を渡した実行で「全件通した」と記録すると、
#      次のセッションが嘘の緑を信じる。引数があるときは走らせるだけにする。
if [ "$#" -ne 0 ]; then
  echo "[run-e2e-tests] 引数付きの実行なので記録しません（全件を通したときだけ記録する）"
  exit "$EXIT_CODE"
fi

E2E_TREE="$(git rev-parse "HEAD:e2e" 2>/dev/null || echo unknown)"
SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
E2E_DIRTY="false"
SRC_DIRTY="false"
if ! git diff --quiet -- e2e 2>/dev/null; then E2E_DIRTY="true"; fi
if ! git diff --quiet -- src 2>/dev/null; then SRC_DIRTY="true"; fi

python3 - "$LOG_FILE" "$RESULT" "$EXIT_CODE" "$E2E_TREE" "$SRC_TREE" "$COMMIT" "$BRANCH" "$E2E_DIRTY" "$SRC_DIRTY" <<'PY'
import json, sys
from datetime import datetime, timezone

log_file, result, exit_code, e2e_tree, src_tree, commit, branch, e2e_dirty, src_dirty = sys.argv[1:10]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": result,
    "exitCode": int(exit_code),
    "e2eTree": e2e_tree,
    "srcTree": src_tree,
    "commit": commit,
    "branch": branch,
    # 未コミットの変更がある状態での実行は「その木で通った」証拠にならない
    "e2eDirty": e2e_dirty == "true",
    "srcDirty": src_dirty == "true",
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[run-e2e-tests] {result} を記録しました: {log_file}")
PY

exit "$EXIT_CODE"
