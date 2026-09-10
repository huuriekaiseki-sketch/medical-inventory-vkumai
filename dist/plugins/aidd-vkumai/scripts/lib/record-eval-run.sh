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
#      あわせて**所要時間**と**費用（トークン数）**も残す（提案 3 の「再現性と費用」）。
#      費用は 2026-09-10 に取れる経路を実測で見つけた——`claude -p --output-format json` が
#      `total_cost_usd` と `usage` を返し、`--json-schema` とも併用できる。
#      限界: `total_cost_usd` は表示価格ベースで、実際の請求と一致するとは限らない。
#      モックを使う eval（テスト）では取れないので、**取れた回だけを数える**（下記）。
#
# WHY(記録の作り方を 1 か所に寄せる): 同じ形の printf が 2 つの eval スクリプトにあった。
#      欄を足すときに片方だけ直すと、**同じ問いに 2 か所が別々に答える**（E-053）。
#
# 使い方: source してから
#   record_eval_run <script名> <fixtureセット> <pass> <total> <開始時刻(epoch)> [モデル]

# 使用量の足し上げ（設計提案 3「費用」）。1 回の eval は複数の case を回すので、
# case ごとの費用・トークンをここへ積む。**取れなかった回は 0 として積まない**——
# 取れないことと 0 だったことを混ぜると、費用が過少に見える。
EVAL_COST_USD=0
EVAL_INPUT_TOKENS=0
EVAL_OUTPUT_TOKENS=0
# WHY(キャッシュ読み込み分を別に積む、2026-09-10): `usage.input_tokens` は
#      **キャッシュから読んだ分を含まない**。実測で input_tokens=6 に対し
#      cache_read_input_tokens=17,547 という回があり、`入力 6 トークン` とだけ出すと
#      **プロンプトが 6 トークンだったように読める**。合算もしない——
#      価格が違うので足すと別の嘘になる。別の欄で並べる。
EVAL_CACHE_READ_TOKENS=0
EVAL_USAGE_SAMPLES=0
EVAL_USAGE_MISSING=0

# $1 = agent-output.mjs --usage の出力（JSON 1 行）
accumulate_usage() {
  # WHY(既定値に {} と書かない、2026-09-10): `${1:-{}}` は bash が `${1:-{` までを展開と読み、
  #      末尾の `}` を**素の文字として後ろに足す**。渡された JSON が `...}}` になって壊れ、
  #      **実測できた回まで「取れなかった」に落ちていた**（check-agent-output.test.sh の
  #      シナリオ 7 が掴んだ）。空なら空のまま渡し、JSON として読めない＝取れなかった、で揃える。
  local usage="${1:-}"
  local parsed
  parsed="$(printf '%s' "$usage" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
cost = d.get('costUsd')
i = d.get('inputTokens')
o = d.get('outputTokens')
c = d.get('cacheReadTokens')
if cost is None and i is None and o is None and c is None:
    print('missing 0 0 0 0')
else:
    print(f\"ok {cost or 0} {i or 0} {o or 0} {c or 0}\")
" 2>/dev/null || echo "missing 0 0 0 0")"
  local kind cost inp outp cached
  read -r kind cost inp outp cached <<< "$parsed"
  if [ "$kind" = "missing" ]; then
    EVAL_USAGE_MISSING=$((EVAL_USAGE_MISSING + 1))
    return 0
  fi
  EVAL_USAGE_SAMPLES=$((EVAL_USAGE_SAMPLES + 1))
  EVAL_COST_USD="$(python3 -c "print(round(${EVAL_COST_USD} + ${cost}, 6))" 2>/dev/null || echo "$EVAL_COST_USD")"
  EVAL_INPUT_TOKENS=$((EVAL_INPUT_TOKENS + inp))
  EVAL_OUTPUT_TOKENS=$((EVAL_OUTPUT_TOKENS + outp))
  EVAL_CACHE_READ_TOKENS=$((EVAL_CACHE_READ_TOKENS + cached))
  return 0
}

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
    "$workflows_tree" "$fixtures_tree" "$commit" "$branch" "$elapsed" "$model" \
    "${EVAL_COST_USD:-0}" "${EVAL_INPUT_TOKENS:-0}" "${EVAL_OUTPUT_TOKENS:-0}" \
    "${EVAL_USAGE_SAMPLES:-0}" "${EVAL_USAGE_MISSING:-0}" "${EVAL_CACHE_READ_TOKENS:-0}" <<'PY' || return 0
import json, sys
from datetime import datetime, timezone

(file, script, fixture_set, passed, total,
 workflows_tree, fixtures_tree, commit, branch, elapsed, model,
 cost_usd, input_tokens, output_tokens, usage_samples, usage_missing,
 cache_read_tokens) = sys.argv[1:18]
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
    # 時間（秒）
    "elapsedSeconds": int(elapsed),
}
if model:
    row["model"] = model
# 費用とトークン（2026-09-10。`claude -p --output-format json` から取れることを実測した）。
# **取れた回が 1 回も無ければ欄そのものを書かない**——0 円だったのか取れなかったのかを混ぜない
if int(usage_samples) > 0:
    row["costUsd"] = float(cost_usd)
    row["inputTokens"] = int(input_tokens)
    row["outputTokens"] = int(output_tokens)
    # キャッシュから読んだ入力。**inputTokens に足さない**（価格が違う）
    row["cacheReadTokens"] = int(cache_read_tokens)
    row["usageSamples"] = int(usage_samples)
if int(usage_missing) > 0:
    # 使用量を取れなかった回。混ぜずに件数で残す
    row["usageMissing"] = int(usage_missing)
with open(file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
  return 0
}
