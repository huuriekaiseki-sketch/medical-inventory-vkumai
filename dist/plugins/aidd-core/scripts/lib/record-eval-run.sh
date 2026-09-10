#!/usr/bin/env bash
# eval の実行を docs/agents/eval-runs.jsonl へ 1 行残す（共通）。
#
# WHY(条件を残す、2026-09-10・レビューの設計提案 3「再現性と費用」):
#      それまで記録は「いつ / どの fixture セット / 何件通ったか」しか持っていなかった。
#      これだと**同じ条件で複数回回したときのばらつき**を測れない——
#      「0% 〜 100% で振れている」と出ても、それが**モデルの揺れ**なのか
#      **その間にコードが変わっただけ**なのか区別できない。
#      区別できない数字は判断に使えないので、条件（何を測った木か・どのモデルか）を一緒に残す。
#
#      あわせて**所要時間**も残す（提案 3 の「再現性と費用」のうち時間の側）。
#      費用はトークン数を取れる経路がまだ無いので残していない（限界として明記する）。
#
# WHY(記録の作り方を 1 か所に寄せる): 同じ形の printf が 2 つの eval スクリプトにあった。
#      欄を足すときに片方だけ直すと、**同じ問いに 2 か所が別々に答える**（E-053）。
#
# 使い方: source してから
#   record_eval_run <script名> <fixtureセット> <pass> <total> <開始時刻(epoch)> [モデル]

# WHY(記録が本題を壊さない、2026-09-10): 呼び出し元の eval スクリプトは `set -euo pipefail` で動く。
#      最初の版はリポジトリを解決できないときに `cd` が失敗し、**呼び出し元ごと異常終了させて**
#      その回の不一致の報告が出力されなくなった（テストが掴んだ）。
#      記録は付随物で、失敗しても本題（eval の結果の報告）を止めてはいけない。
#      そのためこの関数は**必ず 0 で返る**。
#
# $1=script, $2=fixtureSet, $3=pass, $4=total, $5=開始時刻(epoch秒), $6=モデル(省略可)
record_eval_run() {
  local script="$1" fixture_set="$2" pass="$3" total="$4" started="$5" model="${6:-}"
  local repo_dir="${EVAL_RUNS_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/..}"
  if [ -d "$repo_dir" ]; then
    repo_dir="$(cd "$repo_dir" && pwd)"
  fi
  local file="${EVAL_RUNS_FILE:-$repo_dir/docs/agents/eval-runs.jsonl}"
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0

  # 条件: 何を測ったか（プロンプトの木と fixture の木）。取れなければ unknown
  #
  # WHY(--verify --quiet を付ける、2026-09-10): `git rev-parse HEAD:<path>` は
  #      **解決できないとき引数そのものを標準出力へ出して**非ゼロで終わる。
  #      `2>/dev/null || echo unknown` だけだと `HEAD:scripts/eval-fixtures\nunknown` という
  #      2 行の値が記録に入る（テストの fixture リポジトリで実際に起きた）。
  #      条件の欄が壊れると、ばらつきの比較が**永久に一致しなくなる**ので黙って壊れてはいけない。
  local workflows_tree fixtures_tree commit branch elapsed
  tree_of() { git -C "$repo_dir" rev-parse --verify --quiet "HEAD:$1" 2>/dev/null || echo unknown; }
  workflows_tree="$(tree_of ".claude/workflows")"
  fixtures_tree="$(tree_of "scripts/eval-fixtures")"
  commit="$(git -C "$repo_dir" rev-parse --short --verify --quiet HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$repo_dir" branch --show-current 2>/dev/null || echo unknown)"
  [ -n "$branch" ] || branch=unknown
  elapsed=$(( $(date +%s) - started ))

  # 記録に失敗しても本題を止めない（|| return 0）
  python3 - "$file" "$script" "$fixture_set" "$pass" "$total" \
    "$workflows_tree" "$fixtures_tree" "$commit" "$branch" "$elapsed" "$model" <<'PY' || return 0
import json, sys
from datetime import datetime, timezone

(file, script, fixture_set, passed, total,
 workflows_tree, fixtures_tree, commit, branch, elapsed, model) = sys.argv[1:12]
row = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "script": script,
    "fixtureSet": fixture_set,
    "pass": int(passed),
    "total": int(total),
    # 条件。**同じ条件の回どうしでしかばらつきを比べてはいけない**
    "workflowsTree": workflows_tree,
    "fixturesTree": fixtures_tree,
    "commit": commit,
    "branch": branch,
    # 時間（秒）。費用はトークン数を取れる経路がまだ無いので残していない
    "elapsedSeconds": int(elapsed),
}
if model:
    row["model"] = model
with open(file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
  return 0
}
