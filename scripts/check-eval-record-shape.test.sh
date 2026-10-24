#!/usr/bin/env bash
# WHY(2026-10-24・issue #907): Anthropic の 2026-09-28 の記事「Automating eval design and hillclimbing」の
#      過学習対策を、eval の**記録の形**と**採用の判定**として機械で固定する。
#      deep ルートの Find プロンプトを締めて recall が 11/17 → 5/17 に落ちた件（issue #796）は、
#      「1 回の数字で判断した」「調整に使った fixture で測った」の 2 つが重なった型で、
#      ルール文書に書くだけでは第 3 層（破られても気づけない）に落ちる。
#
#      固定するのは 4 つ:
#        (a) 記録行の形: 新しい記録は split / runs / runPass を持ち、runPass の合計 = pass、
#            2 run 以上なら noiseWidth = 最大 − 最小、1 run なら noiseWidth を**持たない**
#            （1 回の実行から「幅 0」とは言えない。C-025）。昔の形の行は書き換えずに通す
#        (b) train と test が同じ fixture を含まない（中身の sha256 で見る）。test が消えたら落ちる
#        (c) ノイズ幅の無い記録・ノイズ内の改善・test が改善していない変更は「採用」と**書けない**
#            （record-eval-decision.sh が拒む。判定エンジンは scan-eval-record-shape.mjs の judge）
#        (d) 新しい欄を足しても読む側（鮮度検査 check-eval-runs-freshness.sh）が壊れない
#
#      どれも RED 方向（壊した fixture で落ちる）と対照（正しい形は通る）を対で持つ（C-021 / C-022）。
#
# 実行: bash scripts/check-eval-record-shape.test.sh
set -uo pipefail

export LC_ALL=C.UTF-8

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCAN="$SCRIPT_DIR/lib/scan-eval-record-shape.mjs"
DECIDE="$SCRIPT_DIR/record-eval-decision.sh"
FRESHNESS="$SCRIPT_DIR/check-eval-runs-freshness.sh"

command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので記録の形を測れない。守られているかは分かりません）"
  echo "ALL PASSED"
  exit 0
}

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() { if grep -qF -- "$2" <<<"$1"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }
assert_not_contains() { if grep -qF -- "$2" <<<"$1"; then ng "$3" "unexpected: $2 / actual: $1"; else ok "$3"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

run_scan() { # $@ = サブコマンドと引数
  SCAN_OUT="$(node "$SCAN" "$@" 2>&1)"
  SCAN_CODE=$?
}

# ---------------------------------------------------------------------------
echo "=== scenario 1: 実態の記録に違反が無い（ratchet 0） ==="
run_scan records "$REPO_ROOT/docs/agents/eval-runs.jsonl"
if [ "$SCAN_CODE" -eq 0 ]; then ok "記録行の形に違反 0 件"; else ng "実態の記録で違反が出た" "$SCAN_OUT"; fi
if grep -qE "rows=[1-9]" <<<"$SCAN_OUT"; then ok "記録を実際に読んでいる（空振りでない）"; else ng "記録が 0 行" "$SCAN_OUT"; fi

echo "=== scenario 2: 実態の fixture で train と test が同じ中身を持たない ==="
run_scan fixtures "$REPO_ROOT/scripts/eval-fixtures"
if [ "$SCAN_CODE" -eq 0 ]; then ok "train / test の重複 0 件"; else ng "実態の fixture で重複が出た" "$SCAN_OUT"; fi
if grep -qE "test-cases=[1-9]" <<<"$SCAN_OUT"; then ok "test（held-out）の case を実際に見つけている"; else ng "test の case が 0 件" "$SCAN_OUT"; fi
if grep -qE "train-cases=[1-9]" <<<"$SCAN_OUT"; then ok "train の case も見つけている"; else ng "train の case が 0 件" "$SCAN_OUT"; fi

echo "=== scenario 3: 実態の採用記録（あれば）が今も条件を満たす ==="
run_scan decisions "$REPO_ROOT/docs/agents/eval-decisions.jsonl" "$REPO_ROOT/docs/agents/eval-runs.jsonl"
if [ "$SCAN_CODE" -eq 0 ]; then ok "採用記録に違反 0 件（$(tail -n 1 <<<"$SCAN_OUT")）"; else ng "採用記録で違反が出た" "$SCAN_OUT"; fi

# ---------------------------------------------------------------------------
echo "=== scenario 4: recorder が新しい欄を書く（run ごとの合格数・ノイズ幅・split） ==="
# 一時の git リポジトリで record_eval_run を直接呼ぶ（check-agent-output.test.sh の scenario 9 と同型）
FX="$WORK/repo"
mkdir -p "$FX/.claude/workflows" "$FX/scripts/eval-fixtures/sweep-x/case-1" "$FX/scripts/eval-fixtures/sweep-x-holdout/case-1" "$FX/docs/agents"
git -C "$FX" init -q
git -C "$FX" config user.email test@example.test
git -C "$FX" config user.name t
printf 'x\n' > "$FX/.claude/workflows/a.js"
printf '{"expectedFilePathContains":"a.ts","expectedKeywords":["k"]}' > "$FX/scripts/eval-fixtures/sweep-x/case-1/expected.json"
printf '{"heldOut":true,"expectedFilePathContains":"b.ts","expectedKeywords":["k"]}' > "$FX/scripts/eval-fixtures/sweep-x-holdout/case-1/expected.json"
git -C "$FX" add -A
git -C "$FX" commit -qm base
RUNS="$FX/docs/agents/eval-runs.jsonl"
# shellcheck source=lib/record-eval-run.sh
source "$SCRIPT_DIR/lib/record-eval-run.sh"

EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" EVAL_RUN_PASSES="2 1 2" \
  EVAL_FIXTURE_SET_DIR="$FX/scripts/eval-fixtures/sweep-x" \
  record_eval_run "eval-sweep-recall" "sweep-x" 5 6 "$(date +%s)" "haiku"
ROW="$(tail -n 1 "$RUNS")"
assert_contains "$ROW" '"runs": 3' "何 run 回したかを残す"
assert_contains "$ROW" '"runPass": [2, 1, 2]' "run ごとの合格数を残す"
assert_contains "$ROW" '"noiseWidth": 1' "ノイズ幅 = 最大 − 最小"
assert_contains "$ROW" '"passMin": 1' "最小"
assert_contains "$ROW" '"passMax": 2' "最大"
assert_contains "$ROW" '"passStdev": 0.471' "標準偏差相当も残す（判定には使わない）"
assert_contains "$ROW" '"split": "train"' "印の無いセットは train"
assert_contains "$ROW" '"pass": 5, "total": 6' "pass / total は全 run の合算（読む側の pass / total が壊れない）"

EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" \
  EVAL_FIXTURE_SET_DIR="$FX/scripts/eval-fixtures/sweep-x-holdout" \
  record_eval_run "eval-sweep-recall" "sweep-x-holdout" 1 1 "$(date +%s)" "haiku"
ROW1="$(tail -n 1 "$RUNS")"
assert_contains "$ROW1" '"split": "test"' "heldOut: true のセットは test"
assert_contains "$ROW1" '"runs": 1' "run の指定が無ければ 1 run"
assert_contains "$ROW1" '"runPass": [1]' "1 run でも内訳の形は同じ"
assert_not_contains "$ROW1" '"noiseWidth"' "1 run の記録にノイズ幅を書かない（幅 0 とは言えない）"

# セットのディレクトリが無い呼び出し（既存テストの形）は名前で決める
EVAL_RUNS_REPO_DIR="$FX" EVAL_RUNS_FILE="$RUNS" record_eval_run "t" "set-holdout" 1 1 "$(date +%s)" "m"
assert_contains "$(tail -n 1 "$RUNS")" '"split": "test"' "ディレクトリが無ければ -holdout の名前で test と決める"

run_scan records "$RUNS"
if [ "$SCAN_CODE" -eq 0 ]; then ok "recorder が書いた行は走査を通る（対照）"; else ng "recorder の出力を走査が落とした" "$SCAN_OUT"; fi
if grep -qE "checked=3" <<<"$SCAN_OUT"; then ok "3 行とも新しい形として検査した"; else ng "検査した行数が合わない" "$SCAN_OUT"; fi

# ---------------------------------------------------------------------------
echo "=== scenario 5: 壊れた記録行は落ちる（RED 方向） ==="
# WHY(日付を固定する): `date -u` だと JST の朝は UTC では前日で、cutoff（2026-10-24）より前の
#      日付になって「昔の形」として通ってしまう（最初そうなって RED が空振りした）。
#      見たいのは「cutoff 以降の日付の手書き行」なので、確実に cutoff より後の日付を使う
TODAY="2026-11-01T00:00:00Z"
BAD="$WORK/bad.jsonl"
cp "$RUNS" "$BAD"
# 手書きの昔の形（split / runs が無い）を今日の日付で足す
printf '{"timestamp":"%s","script":"eval-sweep-recall","fixtureSet":"sweep-x","pass":1,"total":1,"workflowsTree":"abc"}\n' "$TODAY" >> "$BAD"
run_scan records "$BAD"
if [ "$SCAN_CODE" -ne 0 ]; then ok "新しい日付の昔の形で落ちる"; else ng "昔の形の手書き行を通した" "$SCAN_OUT"; fi
assert_contains "$SCAN_OUT" "missing-split" "欠けた欄を名指しする"

cp "$RUNS" "$BAD"
printf '{"timestamp":"%s","script":"t","fixtureSet":"s","pass":3,"total":4,"split":"train","runs":2,"runPass":[1,1],"noiseWidth":0}\n' "$TODAY" >> "$BAD"
run_scan records "$BAD"
assert_contains "$SCAN_OUT" "runpass-sum" "runPass の合計が pass と合わなければ落ちる"

cp "$RUNS" "$BAD"
printf '{"timestamp":"%s","script":"t","fixtureSet":"s","pass":1,"total":1,"split":"train","runs":1,"runPass":[1],"noiseWidth":0}\n' "$TODAY" >> "$BAD"
run_scan records "$BAD"
assert_contains "$SCAN_OUT" "noise-on-single-run" "1 run の記録にノイズ幅が書いてあれば落ちる（幅 0 と測っていないを混ぜない）"

cp "$RUNS" "$BAD"
printf '{"timestamp":"%s","script":"t","fixtureSet":"s","pass":3,"total":4,"split":"train","runs":2,"runPass":[1,2],"noiseWidth":0}\n' "$TODAY" >> "$BAD"
run_scan records "$BAD"
assert_contains "$SCAN_OUT" "noise-mismatch" "ノイズ幅が最大 − 最小と合わなければ落ちる"

cp "$RUNS" "$BAD"
printf '{"timestamp":"%s","script":"t","fixtureSet":"s","pass":2,"total":2,"split":"mixed","runs":2,"runPass":[1,1],"noiseWidth":0}\n' "$TODAY" >> "$BAD"
run_scan records "$BAD"
assert_contains "$SCAN_OUT" "bad-split" "split が train / test 以外なら落ちる"

# 昔の形でも、cutoff より前の日付なら通す（過去の記録は書き換えない）
cp "$RUNS" "$BAD"
printf '{"timestamp":"2026-09-10T00:00:00Z","script":"eval-sweep-recall","fixtureSet":"sweep-x","pass":1,"total":1}\n' >> "$BAD"
run_scan records "$BAD"
if [ "$SCAN_CODE" -eq 0 ]; then ok "cutoff より前の昔の形は通す（対照）"; else ng "過去の記録を落とした" "$SCAN_OUT"; fi

# 空のファイルは「違反 0」ではなく走査の失敗
: > "$WORK/empty.jsonl"
run_scan records "$WORK/empty.jsonl"
if [ "$SCAN_CODE" -ne 0 ]; then ok "記録が 0 行なら落ちる（fail-open 防止）"; else ng "0 行で通した" "$SCAN_OUT"; fi

# ---------------------------------------------------------------------------
echo "=== scenario 6: train と test が同じ fixture を含んだら落ちる（RED 方向） ==="
mk_case() { # $1=root, $2=set, $3=case, $4=expected.json, $5=ファイル名, $6=中身
  mkdir -p "$1/$2/$3/files/src"
  printf '%s' "$4" > "$1/$2/$3/expected.json"
  printf '%s\n' "$6" > "$1/$2/$3/files/src/$5"
}
GOOD="$WORK/fx-good"
mk_case "$GOOD" "sweep-x" "case-1" '{"expectedFilePathContains":"ward-list.ts","expectedKeywords":["x"]}' "ward-list.ts" "export const a = 1"
mk_case "$GOOD" "sweep-x-holdout" "case-1" '{"heldOut":true,"expectedFilePathContains":"sterile-log.ts","expectedKeywords":["y"]}' "sterile-log.ts" "export const b = 2"
run_scan fixtures "$GOOD"
if [ "$SCAN_CODE" -eq 0 ]; then ok "中身が違えば通る（対照）"; else ng "正しい構成で落ちた" "$SCAN_OUT"; fi

DUP="$WORK/fx-dup"
mk_case "$DUP" "sweep-x" "case-1" '{"expectedFilePathContains":"ward-list.ts","expectedKeywords":["x"]}' "ward-list.ts" "export const same = 1"
# 名前は違うが中身が同じ（コピーして名前だけ変えた held-out）
mk_case "$DUP" "sweep-x-holdout" "case-1" '{"heldOut":true,"expectedFilePathContains":"sterile-log.ts","expectedKeywords":["x"]}' "sterile-log.ts" "export const same = 1"
run_scan fixtures "$DUP"
if [ "$SCAN_CODE" -ne 0 ]; then ok "同じ中身が train と test の両側にあれば落ちる"; else ng "重複を通した" "$SCAN_OUT"; fi
assert_contains "$SCAN_OUT" "shared-fixture" "どの case どうしかを名指しする"

NOTEST="$WORK/fx-notest"
mk_case "$NOTEST" "sweep-x" "case-1" '{"expectedFilePathContains":"ward-list.ts","expectedKeywords":["x"]}' "ward-list.ts" "export const a = 1"
run_scan fixtures "$NOTEST"
if [ "$SCAN_CODE" -ne 0 ]; then ok "test（held-out）が 0 件なら落ちる（この検査が何も守らなくなる状態）"; else ng "test 0 件で通した" "$SCAN_OUT"; fi
run_scan fixtures "$NOTEST" --allow-no-test
if [ "$SCAN_CODE" -eq 0 ]; then ok "本当に持たない導入先は --allow-no-test で明示できる"; else ng "明示しても落ちる" "$SCAN_OUT"; fi

# ---------------------------------------------------------------------------
echo "=== scenario 7: ノイズ幅より大きい改善が train と test の両方にあるときだけ「採用」と書ける ==="
# 4 行（変更前後 × train / test）の記録を手で作る。ts は引くための鍵
mk_row() { # $1=file $2=ts $3=set $4=split $5=runPass(JSON) $6=pass $7=total $8=workflowsTree $9=extra(JSON の断片。先頭に , を付ける)
  printf '{"timestamp":"%s","script":"eval-sweep-recall","fixtureSet":"%s","split":"%s","runs":3,"runPass":%s,"pass":%s,"total":%s,"passMean":%s,"noiseWidth":%s,"workflowsTree":"%s","agentsTree":"ag","fixturesTree":"fx","judgeBlob":"jb","model":"haiku","workflowsDirty":false,"agentsDirty":false%s}\n' \
    "$2" "$3" "$4" "$5" "$6" "$7" "$(node -e 'const a=JSON.parse(process.argv[1]);process.stdout.write(String(a.reduce((x,y)=>x+y,0)/a.length))' "$5")" \
    "$(node -e 'const a=JSON.parse(process.argv[1]);process.stdout.write(String(Math.max(...a)-Math.min(...a)))' "$5")" "$8" "${9:-}" >> "$1"
}
GOODRUNS="$WORK/good-runs.jsonl"
: > "$GOODRUNS"
mk_row "$GOODRUNS" "2026-11-01T00:00:00Z" "sweep-x"         "train" "[1,1,1]" 3 6 "treeA"   # 変更前 train: 1/2 が 3 回
mk_row "$GOODRUNS" "2026-11-01T01:00:00Z" "sweep-x"         "train" "[2,2,2]" 6 6 "treeB"   # 変更後 train: 2/2 が 3 回
mk_row "$GOODRUNS" "2026-11-01T00:10:00Z" "sweep-x-holdout" "test"  "[0,0,0]" 0 3 "treeA"   # 変更前 test: 0/1
mk_row "$GOODRUNS" "2026-11-01T01:10:00Z" "sweep-x-holdout" "test"  "[1,1,1]" 3 3 "treeB"   # 変更後 test: 1/1
DEC="$WORK/decisions.jsonl"
run_decide() { # $1=decision, 残り=追加引数
  local d="$1"; shift
  DECIDE_OUT="$(EVAL_RUNS_FILE="$GOODRUNS" EVAL_DECISIONS_FILE="$DEC" bash "$DECIDE" --decision "$d" \
    --before-train 2026-11-01T00:00:00Z --after-train 2026-11-01T01:00:00Z \
    --before-test 2026-11-01T00:10:00Z --after-test 2026-11-01T01:10:00Z \
    --change "テスト用の変更" "$@" 2>&1)"
  DECIDE_CODE=$?
}
run_decide adopted
if [ "$DECIDE_CODE" -eq 0 ]; then ok "両方がノイズ幅より大きく改善していれば採用を書ける（対照）"; else ng "正当な採用を拒んだ" "$DECIDE_OUT"; fi
if [ -f "$DEC" ] && grep -q '"decision":"adopted"' "$DEC"; then ok "採用の行が書かれる"; else ng "採用の行が無い" "$(cat "$DEC" 2>/dev/null)"; fi
assert_contains "$(tail -n 1 "$DEC")" '"noiseWidth":0' "判定に使ったノイズ幅を行に残す"
assert_contains "$(tail -n 1 "$DEC")" '"improvement":1' "改善幅を行に残す"
run_scan decisions "$DEC" "$GOODRUNS"
if [ "$SCAN_CODE" -eq 0 ]; then ok "書いた採用記録は読み直しても条件を満たす"; else ng "自分で書いた採用記録を落とした" "$SCAN_OUT"; fi

echo "=== scenario 7b: ノイズ幅の無い記録（1 run）では「採用」と書けない（RED 方向） ==="
SINGLE="$WORK/single-runs.jsonl"
: > "$SINGLE"
for spec in "2026-11-01T00:00:00Z sweep-x train 1 2 treeA" "2026-11-01T01:00:00Z sweep-x train 2 2 treeB" \
            "2026-11-01T00:10:00Z sweep-x-holdout test 0 1 treeA" "2026-11-01T01:10:00Z sweep-x-holdout test 1 1 treeB"; do
  read -r ts set split pass total tree <<<"$spec"
  printf '{"timestamp":"%s","script":"eval-sweep-recall","fixtureSet":"%s","split":"%s","runs":1,"runPass":[%s],"pass":%s,"total":%s,"workflowsTree":"%s","agentsTree":"ag","fixturesTree":"fx","judgeBlob":"jb","model":"haiku","workflowsDirty":false,"agentsDirty":false}\n' \
    "$ts" "$set" "$split" "$pass" "$pass" "$total" "$tree" >> "$SINGLE"
done
SAVED_GOODRUNS="$GOODRUNS"; GOODRUNS="$SINGLE"
rm -f "$DEC"
run_decide adopted
if [ "$DECIDE_CODE" -ne 0 ]; then ok "1 run の記録では採用を拒む"; else ng "ノイズ幅の無い記録で採用を書けた" "$DECIDE_OUT"; fi
assert_contains "$DECIDE_OUT" "no-noise-width" "理由にノイズ幅が無いことを名指しする"
if [ ! -f "$DEC" ]; then ok "拒んだときは行を書かない"; else ng "拒んだのに行を書いた" "$(cat "$DEC")"; fi
run_decide rejected
if [ "$DECIDE_CODE" -eq 0 ]; then ok "見送り（rejected）はいつでも書ける（見送った記録も残す）"; else ng "見送りを拒んだ" "$DECIDE_OUT"; fi
assert_contains "$(tail -n 1 "$DEC")" '"decision":"rejected"' "見送りの行"
assert_contains "$(tail -n 1 "$DEC")" '"reasons":[' "見送りの行にも判定の理由を残す"
GOODRUNS="$SAVED_GOODRUNS"

echo "=== scenario 7c: 改善がノイズ幅以下なら「採用」と書けない（RED 方向） ==="
NOISY="$WORK/noisy-runs.jsonl"
: > "$NOISY"
mk_row "$NOISY" "2026-11-01T00:00:00Z" "sweep-x"         "train" "[1,2,1]" 4 6 "treeA"   # 揺れている（幅 1）
mk_row "$NOISY" "2026-11-01T01:00:00Z" "sweep-x"         "train" "[2,2,2]" 6 6 "treeB"   # 平均 1.33 → 2（改善 0.67 ≤ 幅 1）
mk_row "$NOISY" "2026-11-01T00:10:00Z" "sweep-x-holdout" "test"  "[0,0,0]" 0 3 "treeA"
mk_row "$NOISY" "2026-11-01T01:10:00Z" "sweep-x-holdout" "test"  "[1,1,1]" 3 3 "treeB"
GOODRUNS="$NOISY"
rm -f "$DEC"
run_decide adopted
if [ "$DECIDE_CODE" -ne 0 ]; then ok "ノイズ内の改善は採用を拒む"; else ng "ノイズ内の改善で採用を書けた" "$DECIDE_OUT"; fi
assert_contains "$DECIDE_OUT" "within-noise: train" "どちら側がノイズ内かを名指しする"
GOODRUNS="$SAVED_GOODRUNS"

echo "=== scenario 7d: train だけ良くなって test が良くなっていなければ「採用」と書けない（過学習の型） ==="
TRAINONLY="$WORK/trainonly-runs.jsonl"
: > "$TRAINONLY"
mk_row "$TRAINONLY" "2026-11-01T00:00:00Z" "sweep-x"         "train" "[1,1,1]" 3 6 "treeA"
mk_row "$TRAINONLY" "2026-11-01T01:00:00Z" "sweep-x"         "train" "[2,2,2]" 6 6 "treeB"
mk_row "$TRAINONLY" "2026-11-01T00:10:00Z" "sweep-x-holdout" "test"  "[1,1,1]" 3 3 "treeA"
mk_row "$TRAINONLY" "2026-11-01T01:10:00Z" "sweep-x-holdout" "test"  "[0,0,0]" 0 3 "treeB"   # test は悪化
GOODRUNS="$TRAINONLY"
rm -f "$DEC"
run_decide adopted
if [ "$DECIDE_CODE" -ne 0 ]; then ok "test が改善していなければ採用を拒む"; else ng "train だけの改善で採用を書けた" "$DECIDE_OUT"; fi
assert_contains "$DECIDE_OUT" "within-noise: test" "test 側を名指しする"
GOODRUNS="$SAVED_GOODRUNS"

echo "=== scenario 7e: 条件の違う回（fixture の木が違う）は比べない ==="
COND="$WORK/cond-runs.jsonl"
: > "$COND"
mk_row "$COND" "2026-11-01T00:00:00Z" "sweep-x"         "train" "[1,1,1]" 3 6 "treeA"
mk_row "$COND" "2026-11-01T01:00:00Z" "sweep-x"         "train" "[2,2,2]" 6 6 "treeB" ',"fixturesTreeOverride":1'
mk_row "$COND" "2026-11-01T00:10:00Z" "sweep-x-holdout" "test"  "[0,0,0]" 0 3 "treeA"
mk_row "$COND" "2026-11-01T01:10:00Z" "sweep-x-holdout" "test"  "[1,1,1]" 3 3 "treeB"
# 2 行目の fixturesTree を書き換える（fixture を足した後に測った回）
sed -i.bak 's/"fixturesTree":"fx","judgeBlob":"jb","model":"haiku","workflowsDirty":false,"agentsDirty":false,"fixturesTreeOverride":1/"fixturesTree":"fx2","judgeBlob":"jb","model":"haiku","workflowsDirty":false,"agentsDirty":false/' "$COND"
GOODRUNS="$COND"
rm -f "$DEC"
run_decide adopted
if [ "$DECIDE_CODE" -ne 0 ]; then ok "fixture の木が前後で違えば採用を拒む"; else ng "条件の違う回を比べて採用を書けた" "$DECIDE_OUT"; fi
assert_contains "$DECIDE_OUT" "condition-mismatch" "条件の違いを名指しする"
GOODRUNS="$SAVED_GOODRUNS"

echo "=== scenario 7f: 採用記録を後から改ざんしても読み直しで落ちる ==="
# 1 run の記録しか無いのに「採用」と書かれた行（手書き）
TAMPER="$WORK/tamper-decisions.jsonl"
printf '{"timestamp":"2026-11-02T00:00:00Z","decision":"adopted","change":"手書き","train":{"before":"2026-11-01T00:00:00Z","after":"2026-11-01T01:00:00Z"},"test":{"before":"2026-11-01T00:10:00Z","after":"2026-11-01T01:10:00Z"}}\n' > "$TAMPER"
run_scan decisions "$TAMPER" "$SINGLE"
if [ "$SCAN_CODE" -ne 0 ]; then ok "条件を満たさない採用の行は読み直しで落ちる"; else ng "手書きの採用を通した" "$SCAN_OUT"; fi
assert_contains "$SCAN_OUT" "adopted-but-not-allowed" "どの行かを名指しする"

echo "=== scenario 7g: 入口の引数の欠けは判定より前に止める ==="
DECIDE_OUT="$(EVAL_RUNS_FILE="$GOODRUNS" EVAL_DECISIONS_FILE="$WORK/x.jsonl" bash "$DECIDE" --decision adopted --change "x" \
  --before-train 2026-11-01T00:00:00Z --after-train 2026-11-01T01:00:00Z 2>&1)"
DECIDE_CODE=$?
if [ "$DECIDE_CODE" -eq 2 ]; then ok "test 側の指定が無ければ使い方の誤りとして止める（train だけでは根拠にならない）"; else ng "test 無しで進んだ（exit=${DECIDE_CODE}）" "$DECIDE_OUT"; fi
DECIDE_OUT="$(EVAL_RUNS_FILE="$GOODRUNS" EVAL_DECISIONS_FILE="$WORK/x.jsonl" bash "$DECIDE" --decision adopted \
  --before-train a --after-train b --before-test c --after-test d 2>&1)"
DECIDE_CODE=$?
if [ "$DECIDE_CODE" -eq 2 ]; then ok "--change（何を変えたか）が無ければ止める"; else ng "変更内容無しで進んだ" "$DECIDE_OUT"; fi

# ---------------------------------------------------------------------------
echo "=== scenario 8: 新しい欄を足しても読む側（鮮度検査）が壊れない ==="
RD="$WORK/reader"
mkdir -p "$RD/.claude/workflows" "$RD/docs/agents"
git -C "$RD" init -q
git -C "$RD" config user.email test@example.test
git -C "$RD" config user.name t
printf 'base\n' > "$RD/.claude/workflows/p.js"
printf '{"timestamp":"2026-09-10T00:00:00Z","script":"eval-sweep-recall","fixtureSet":"s","pass":1,"total":1}\n' > "$RD/docs/agents/eval-runs.jsonl"
git -C "$RD" add -A
git -C "$RD" commit -qm base
git -C "$RD" branch -M main
printf 'changed\n' > "$RD/.claude/workflows/p.js"
git -C "$RD" add -A
git -C "$RD" commit -qm change
NEW_TREE="$(git -C "$RD" rev-parse HEAD:.claude/workflows)"
printf '{"timestamp":"%s","script":"eval-sweep-recall","fixtureSet":"s","pass":5,"total":6,"split":"train","runs":3,"runPass":[2,1,2],"passMin":1,"passMax":2,"passMean":1.667,"passStdev":0.471,"noiseWidth":1,"workflowsTree":"%s","workflowsDirty":false}\n' "$TODAY" "$NEW_TREE" >> "$RD/docs/agents/eval-runs.jsonl"
git -C "$RD" add -A
git -C "$RD" commit -qm "record"
FRESH_OUT="$(cd "$RD" && bash "$FRESHNESS" HEAD~2 HEAD 2>&1)"
FRESH_CODE=$?
if [ "$FRESH_CODE" -eq 0 ]; then ok "新しい形の行を、いまの木で測った記録として読む"; else ng "鮮度検査が新しい形の行を読めない" "$FRESH_OUT"; fi
assert_contains "$FRESH_OUT" "1 行あります" "測った記録を 1 行として数える"
# 読む側が足し算に使う pass / total は合算なので、率は run ごとの平均と一致する
RATE="$(node -e 'const r={pass:5,total:6,runPass:[2,1,2],runs:3};const a=r.pass/r.total;const b=r.runPass.reduce((x,y)=>x+y,0)/r.runs/(r.total/r.runs);process.stdout.write(a===b?"same":"differ")')"
if [ "$RATE" = "same" ]; then ok "pass / total の率と run ごとの平均の率が一致する（合算の設計）"; else ng "合算の率が run の平均と食い違う"; fi

if [ "$fail" -eq 0 ]; then echo "ALL PASSED"; else echo "FAILED"; fi
exit "$fail"
