#!/usr/bin/env bash
# WHY(2026-09-10): 製品コードの変異計測（Stryker）は**人が打たないと動かない**。
#      打ったかどうかを自己申告に頼ると、統合テスト（E-030）・E2E（E-060）で起きたのと同じこと
#      ——いつからか分からないほど前から赤いまま——が起こる。
#      せめて**回したときの結果は自己申告にしない**。実行をここで包み、exit code と
#      **実測したスコア**を logs/mutation-runs.jsonl へ機械的に残す。
#      「通ったことにする」ことはできない（記録するのは実行結果であって主張ではない）。
#
#      記録は check-mutation-freshness.sh（SessionStart hook）が読み、
#      「一度も無い / 前回が赤 / 前回から `src/` か対象の一覧が変わっている / 汚れた木での合格」
#      のいずれかで警告する。**日数ではなく木のハッシュで見る**（無関係な変更で鳴る警告は読まれない）。
#      RLS 側（check-rls-mutation.sh）と同じ形で、判定は共有の scripts/lib/run-freshness.py。
#
# WHY(対象の一覧も見張る): Stryker が壊すのは `stryker.config.json` の `mutate` に書いた場所だけ。
#      **対象を減らせばスコアは上がる**ので、`src/` が変わっていなくても一覧が変われば
#      前の記録は当てにならない。設定ファイルの blob ハッシュを 2 つ目の木として持つ。
#
# 使い方: bash scripts/run-mutation-tests.sh [追加の stryker 引数...]
#   引数付きの実行は記録しない（部分実行を「全件通した」と記録しないため）。
#   1 回 2 分ほどかかる。結果は reports/mutation/ と docs/agents/mutation-testing.md。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"

cd "$REPO_ROOT" || exit 1

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/mutation-runs.jsonl"

# WHY(実行前の時刻を控える、2026-09-10): スコアは reports/mutation/mutation.json から読むが、
#      **この出力が作り直されている保証は無い**（2026-09-07 の実行のまま残っていて、
#      docs だけが「ある」と書いていた）。走り出した時刻より古い出力は
#      「今回の結果」ではないので採らない（C-010: 印を実態と突き合わせない）。
RUN_STARTED_AT="$(python3 -c 'import time; print(time.time())')"

# WHY(npx を使わない): scripts/check-no-registry-fetch.test.sh が hook スクリプトの npx を禁止する。
# RMT_STRYKER_BIN はテスト用の差し替え口（記録の分岐を実行 2 分無しで測るため。既定は変えない）。
"${RMT_STRYKER_BIN:-./node_modules/.bin/stryker}" run "$@"
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  RESULT="pass"
else
  RESULT="fail"
fi

if [ "$#" -ne 0 ]; then
  echo "[run-mutation-tests] 引数付きの実行なので記録しません（全件を通したときだけ記録する）"
  exit "$EXIT_CODE"
fi

SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"
CONFIG_TREE="$(git rev-parse "HEAD:stryker.config.json" 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
SRC_DIRTY="false"
CONFIG_DIRTY="false"
if ! git diff --quiet -- src 2>/dev/null; then SRC_DIRTY="true"; fi
if ! git diff --quiet -- stryker.config.json 2>/dev/null; then CONFIG_DIRTY="true"; fi
SRC_WORKTREE="$(worktree_hash src)"
# WHY(対象の一覧も「いまの姿」で残す、2026-09-10): 手元で mutate の一覧を減らせばスコアは上がる。
#      HEAD の木のハッシュだけだと、その書き換えが未コミットのうちは記録と一致してしまう。
CONFIG_WORKTREE="$(worktree_hash stryker.config.json)"

python3 - "$LOG_FILE" "$RESULT" "$EXIT_CODE" "$SRC_TREE" "$CONFIG_TREE" "$COMMIT" "$BRANCH" \
  "$SRC_DIRTY" "$CONFIG_DIRTY" "$SRC_WORKTREE" "$REPO_ROOT/reports/mutation/mutation.json" \
  "$RUN_STARTED_AT" "$CONFIG_WORKTREE" <<'PY'
import json, os, sys
from datetime import datetime, timezone

(log_file, result, exit_code, src_tree, config_tree, commit, branch,
 src_dirty, config_dirty, src_worktree, report, started_at, config_worktree) = sys.argv[1:14]

# WHY(スコアも残す): 「回した」だけでなく「そのとき何%だったか」が残ると、
#      下限（thresholds.break）を動かしたときに前後を比べられる。読めなければ null。
# WHY(古い出力は採らない): 走り出した時刻より古いファイルは前回の実行の残骸。
#      **無いより悪い**（違う数字を今回の結果として記録してしまう）。
score = None
try:
    if os.path.getmtime(report) < float(started_at):
        raise RuntimeError("stale report")
    with open(report, encoding="utf-8") as f:
        data = json.load(f)
    counts = {}
    for file_result in (data.get("files") or {}).values():
        for m in file_result.get("mutants", []):
            counts[m.get("status")] = counts.get(m.get("status"), 0) + 1
    killed = counts.get("Killed", 0) + counts.get("Timeout", 0)
    total = killed + counts.get("Survived", 0) + counts.get("NoCoverage", 0)
    if total > 0:
        score = round(killed * 100 / total, 2)
except Exception:
    score = None

row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": result,
    "exitCode": int(exit_code),
    "score": score,
    "srcTree": src_tree,
    "strykerTree": config_tree,
    "commit": commit,
    "branch": branch,
    # 未コミットの変更がある状態での実行は「その木で通った」証拠にならない
    "srcDirty": src_dirty == "true",
    "strykerDirty": config_dirty == "true",
    # 未コミットの変更まで含めた「いまの姿」（C-041）
    "srcWorktree": src_worktree,
    "strykerWorktree": config_worktree,
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[run-mutation-tests] {result}（スコア {score}）を記録しました: {log_file}")
PY

exit "$EXIT_CODE"
