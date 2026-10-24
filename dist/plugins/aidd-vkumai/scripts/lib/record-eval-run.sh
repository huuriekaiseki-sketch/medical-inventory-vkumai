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
#   複数 run の回は環境変数で内訳を渡す（issue #907、2026-10-24）:
#     EVAL_RUN_PASSES="2 1 2"        run ごとの合格数（空なら 1 run として <pass> をそのまま使う）
#     EVAL_FIXTURE_SET_DIR=<dir>     セットのディレクトリ（expected.json の heldOut から split を決める）

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

# WHY(走らせる前に言う、2026-09-10・レビュー指摘 R11 の後段):
#   未コミットの有無は `record_eval_run` が記録に残していたが、**実行時には何も出していなかった**。
#   ところがこの 2 つは、走らせている本人がその場で知らないと意味がない:
#
#     - `.claude/workflows` が未コミット → eval は **clone(HEAD)** からプロンプトを読むので、
#       **直したつもりの版は測られていない**。「直したのに数字が変わらない」と悩むことになる
#     - `scripts/eval-fixtures` が未コミット → fixture は**作業ツリー**から読むので測ってはいるが、
#       記録に残る `fixturesTree`（HEAD の木）は**実際に測ったものを表さない**
#
#   ずれ方が逆なので、混ぜずに別々の文で言う。**記録と同じ判定を使う**（E-053: 2 か所で別々に答えない）。
#   $1=リポジトリのパス
warn_if_dirty() {
  local repo_dir="${1:-.}"
  local dirty
  dirty="$(git -C "$repo_dir" status --porcelain -- ".claude/workflows" 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    echo "[eval] 注意: .claude/workflows に未コミットの変更があります。**eval は clone(HEAD) からプロンプトを読むので、その変更は測られません。** 測りたいならコミットしてから回してください。" >&2
  fi
  dirty="$(git -C "$repo_dir" status --porcelain -- ".claude/agents" 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    echo "[eval] 注意: .claude/agents に未コミットの変更があります。**探索手順の変更は測られません**（プロンプトと同じく clone から読みます）。" >&2
  fi
  dirty="$(git -C "$repo_dir" status --porcelain -- "scripts/eval-fixtures" 2>/dev/null || true)"
  if [ -n "$dirty" ]; then
    echo "[eval] 注意: scripts/eval-fixtures に未コミットの変更があります。fixture は作業ツリーから読むので**測ってはいます**が、記録に残る fixturesTree は HEAD の木なので、この回の条件を正しく表しません。" >&2
  fi
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
  local workflows_tree fixtures_tree commit branch elapsed workflows_dirty fixtures_dirty
  local agents_tree agents_dirty judge_blob
  tree_of() { git -C "$repo_dir" rev-parse --verify --quiet "HEAD:$1" 2>/dev/null || echo unknown; }
  workflows_tree="$(tree_of ".claude/workflows")"
  fixtures_tree="$(tree_of "scripts/eval-fixtures")"
  # WHY(エージェントの定義も条件に入れる、2026-09-10): Sweep の実体は
  #      `.claude/agents/<型>.md` の探索手順で、eval もそこから組み立てている。
  #      条件に入れないと**手順を変える前後の回が混ざり**、改善の効果を測れない。
  agents_tree="$(tree_of ".claude/agents")"
  # 採点器。合否の意味が変わったら比べてはいけない。ファイル 1 個なので blob で足りる
  judge_blob="$(tree_of "scripts/lib/judge-sweep-recall.py")"

  # WHY(未コミットかどうかを別に残す、2026-09-10・レビュー R11「どの変更を評価したかまで照合する」):
  #      木のハッシュは **HEAD** のもの。ところが 2 つの入力は出どころが違う。
  #        - fixture は**作業ツリー**から読む（eval スクリプトが $REPO_DIR/scripts/eval-fixtures を見る）
  #          → 未コミットの変更があると、**記録の fixturesTree は実際に測ったものを表さない**
  #        - プロンプトは**clone（HEAD）**から読む
  #          → 未コミットの変更は**評価に入っていない**（直したつもりの版を測っていない）
  #      どちらも「記録と実態がずれている」だが**ずれ方が逆**なので、混ぜずに両方残す。
  #      2026-09-10 に、実行中に fixture を足して自分で踏みかけた。
  dirty_of() {
    if [ -n "$(git -C "$repo_dir" status --porcelain -- "$1" 2>/dev/null)" ]; then
      echo true
    else
      echo false
    fi
  }
  workflows_dirty="$(dirty_of ".claude/workflows")"
  fixtures_dirty="$(dirty_of "scripts/eval-fixtures")"
  # エージェントの定義は clone（HEAD）から読むので、未コミットの変更は**評価に入っていない**
  agents_dirty="$(dirty_of ".claude/agents")"
  commit="$(git -C "$repo_dir" rev-parse --short --verify --quiet HEAD 2>/dev/null || echo unknown)"
  branch="$(git -C "$repo_dir" branch --show-current 2>/dev/null || echo unknown)"
  [ -n "$branch" ] || branch=unknown
  elapsed=$(( $(date +%s) - started ))

  # 記録に失敗しても本題を止めない（|| return 0）
  python3 - "$file" "$script" "$fixture_set" "$pass" "$total" \
    "$workflows_tree" "$fixtures_tree" "$commit" "$branch" "$elapsed" "$model" \
    "${EVAL_COST_USD:-0}" "${EVAL_INPUT_TOKENS:-0}" "${EVAL_OUTPUT_TOKENS:-0}" \
    "${EVAL_USAGE_SAMPLES:-0}" "${EVAL_USAGE_MISSING:-0}" "${EVAL_CACHE_READ_TOKENS:-0}" \
    "$workflows_dirty" "$fixtures_dirty" "$agents_tree" "$agents_dirty" "$judge_blob" \
    "${EVAL_FINDINGS_REPORTED:--1}" "${EVAL_FINDINGS_SAMPLES:-0}" "${EVAL_FINDINGS_UNREADABLE:-0}" \
    "${EVAL_LOOSE_PASS:--1}" "${EVAL_DETAILS_DIR:-}" \
    "${EVAL_RUN_PASSES:-}" "${EVAL_FIXTURE_SET_DIR:-}" <<'PY' || return 0
import json, os, sys, glob, statistics
from datetime import datetime, timezone

(file, script, fixture_set, passed, total,
 workflows_tree, fixtures_tree, commit, branch, elapsed, model,
 cost_usd, input_tokens, output_tokens, usage_samples, usage_missing,
 cache_read_tokens, workflows_dirty, fixtures_dirty,
 agents_tree, agents_dirty, judge_blob,
 findings_reported, findings_samples, findings_unreadable,
 loose_pass, details_dir, run_passes_raw, fixture_set_dir) = sys.argv[1:30]

# WHY(run ごとの合格数を別に残す、2026-10-24・issue #907): Anthropic の 2026-09-28 の記事
#      （Automating eval design and hillclimbing）の「eval のノイズが、検出したい最小の改善より
#      小さいことを先に確かめる」を取り込む。1 回の実行で N run 回したとき（EVAL_RUNS=N）、
#      `pass` / `total` は**全 run の合算**にする——1 run（既定）なら今までと同じ値なので、
#      `pass / total` を読む側（精度指標・鮮度検査）は壊れない。run ごとの内訳は `runPass` に、
#      **ノイズ幅**（run 間の最大 − 最小）は `noiseWidth` に別の欄で残す。
#      1 run の回には `noiseWidth` を**書かない**（0 と「測っていない」を混ぜない。C-025）——
#      採用の判定（導入先の入口）はこの欄が無い回を根拠にできない。
run_passes = [int(x) for x in run_passes_raw.split() if x.strip()]
if not run_passes:
    run_passes = [int(passed)]

# WHY(train / test を記録に残す、2026-10-24・issue #907): held-out（評価専用）セットは 2026-09-10 から
#      `*-holdout` と expected.json の `heldOut: true` で区別してきたが、**記録の側には何も無かった**ので、
#      後から「test 側だけが伸びたか」を機械で集計できなかった。印は fixture 側のものを**読む**だけで、
#      新しい印は作らない（印を 2 か所に持つと食い違う。C-010）。判定は case の expected.json を見て、
#      全部に印があれば test、1 つも無ければ train。混ざっていれば mixed（隔離検査が別に落とす）。
#      セットのディレクトリが渡されない呼び出し（テスト等）はセット名の `-holdout` で決める。
def derive_split(set_dir, set_name):
    if set_dir and os.path.isdir(set_dir):
        flags = []
        for exp in sorted(glob.glob(os.path.join(set_dir, "case-*", "expected.json"))):
            try:
                with open(exp, encoding="utf-8") as fh:
                    flags.append(json.load(fh).get("heldOut") is True)
            except Exception:
                flags.append(False)
        if flags:
            if all(flags):
                return "test"
            if not any(flags):
                return "train"
            return "mixed"
    return "test" if set_name.endswith("-holdout") else "train"

row = {
    "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "script": script,
    "fixtureSet": fixture_set,
    "pass": int(passed),
    "total": int(total),
    # 条件。**同じ条件の回どうしでしかばらつきを比べてはいけない**
    "workflowsTree": workflows_tree,
    "fixturesTree": fixtures_tree,
    # エージェントの定義（探索手順の実体）と採点器も条件のうち
    "agentsTree": agents_tree,
    "judgeBlob": judge_blob,
    # 未コミットの有無。**ずれ方が逆なので混ぜない**——
    #   fixturesDirty=true  → 記録の fixturesTree は実際に測ったものを表さない（fixture は作業ツリーから読む）
    #   workflowsDirty=true → 手元のプロンプトの変更は評価に入っていない（プロンプトは clone=HEAD から読む）
    "fixturesDirty": fixtures_dirty == "true",
    "workflowsDirty": workflows_dirty == "true",
    "agentsDirty": agents_dirty == "true",
    "commit": commit,
    "branch": branch,
    # 時間（秒）
    "elapsedSeconds": int(elapsed),
    # train（調整に使う）か test（held-out・評価専用）か。fixture 側の印を読んだ結果
    "split": derive_split(fixture_set_dir, fixture_set),
    # 何 run 回したか・run ごとの合格数（`pass` はこの合算）
    "runs": len(run_passes),
    "runPass": run_passes,
}
# run 間のばらつき。**2 run 以上の回にだけ書く**——1 回の実行から「幅 0」とは言えない
if len(run_passes) >= 2:
    row["passMin"] = min(run_passes)
    row["passMax"] = max(run_passes)
    row["passMean"] = round(statistics.fmean(run_passes), 3)
    # 母標準偏差（run は全部手元にあるので標本補正はしない）
    row["passStdev"] = round(statistics.pstdev(run_passes), 3)
    # ノイズ幅 = 最大 − 最小。採用の判定はこの値より大きい改善だけを本物と見る
    row["noiseWidth"] = max(run_passes) - min(run_passes)
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
# 実コードへの指摘の多さ（2026-09-10）。**本物か誤りかは分けない**——分けるのは人の仕事。
# 陰性対照は「その fixture への指摘」しか数えないので、実在ファイルへの誤指摘が素通りしていた。
# 読めなかった回は 0 と混ぜない（欄を分ける）
if int(findings_samples) > 0:
    row["findingsReported"] = int(findings_reported)
    row["findingsSamples"] = int(findings_samples)
if int(findings_unreadable) > 0:
    row["findingsUnreadable"] = int(findings_unreadable)
# 従来の判定（本文全体で「パスがある AND キーワードがある」）での合格数。
# 2026-09-10 に判定を「**同じ指摘の中で**そろっているか」へ変えた（R11 の後段）。
# **切り替えの影響を後から測れるように両方を残す**——差が出た回は、
# 「パスとキーワードが別々の指摘に分散していた」＝ 前の判定が甘かった回である。
# -1 は「その eval では測っていない」（0 と混ぜない）
if int(loose_pass) >= 0:
    row["loosePass"] = int(loose_pass)
# 判定に使った回答本文の置き場。**採点器を直したときに過去の回を測り直すために要る**。
# 2026-09-10 まで detail は判定後に捨てていたので、R11 を直しても
# **それ以前の回は永久に測り直せない**（今日の数字は前の判定のまま）。
# logs/ は git 管理外（機械ローカル）なので、ここにはパスだけを残す
if details_dir:
    row["detailsDir"] = details_dir
if int(usage_missing) > 0:
    # 使用量を取れなかった回。混ぜずに件数で残す
    row["usageMissing"] = int(usage_missing)
with open(file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
PY
  return 0
}
