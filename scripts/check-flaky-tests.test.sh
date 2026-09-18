#!/bin/bash
# WHY: scripts/check-flaky-tests.sh と scripts/lib/flaky-aggregate.mjs（issue #757 の 14）の回帰テスト。
#      「揺れる」「毎回落ちる」「毎回通る」を決定的に再現する fixture（scripts/eval-fixtures/flaky/）を
#      本物の vitest で 2 回回し、flaky 1 件だけをちょうど検知し、常時失敗と skip を混同しないことを見る
#      （RED 方向の自己検証）。集計は JSON レポートを直接与えて境界（不読・ファイル全体の失敗）も見る。
#
# 実行: bash scripts/check-flaky-tests.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK="$SCRIPT_DIR/check-flaky-tests.sh"
AGG="$SCRIPT_DIR/lib/flaky-aggregate.mjs"
FIXTURE_CONFIG="scripts/eval-fixtures/flaky/vitest.config.mjs"

command -v node >/dev/null 2>&1 || { echo "node が必要です"; exit 1; }

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() {
  if grep -qF -- "$2" <<<"$1"; then assert_ok "$3"; else assert_fail "$3" "expected: $2"; fi
}
assert_not_contains() {
  if grep -qF -- "$2" <<<"$1"; then assert_fail "$3" "unexpected: $2"; else assert_ok "$3"; fi
}
assert_eq() {
  if [ "$1" = "$2" ]; then assert_ok "$3"; else assert_fail "$3" "expected=$2 actual=$1"; fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: fixture を 2 回回すと flaky 1 件だけを検知し exit 1（RED 方向） ==="
set +e
OUT="$(cd "$REPO_ROOT" && FLAKY_FIXTURE_STATE="$WORK/state" bash "$CHECK" --runs 2 --config "$FIXTURE_CONFIG" --out "$WORK/s1" 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "1" "flaky ありで exit 1"
assert_contains "$OUT" "揺れるテスト（flaky）: 1 件" "flaky をちょうど 1 件"
assert_contains "$OUT" "flaky.test.mjs > fixture: flaky 1 回目は落ち、2 回目以降は通る" "揺れたテストを名指し"
assert_contains "$OUT" "passed 1 / failed 1" "通った回数と落ちた回数"
assert_contains "$OUT" "毎回落ちるテスト（揺れではなくバグ）: 0 件" "常時失敗は 0 件"
assert_not_contains "$OUT" "stable" "毎回通るテストは出ない"
assert_not_contains "$OUT" "skip は数えない" "skip は数えない"
if [ -f "$WORK/s1/flaky-report.md" ]; then assert_ok "flaky-report.md を書く"; else assert_fail "flaky-report.md が無い"; fi
if [ -f "$WORK/s1/run-1.json" ] && [ -f "$WORK/s1/run-2.json" ]; then assert_ok "run-N.json を 2 つ残す"; else assert_fail "run-N.json が揃っていない"; fi

echo "=== scenario 2: 毎回落ちるテストは flaky ではなく常時失敗として exit 2 ==="
set +e
OUT="$(cd "$REPO_ROOT" && FLAKY_FIXTURE_STATE="$WORK/state2" FLAKY_FIXTURE_ALWAYS_FAIL=1 bash "$CHECK" --runs 2 --config "$FIXTURE_CONFIG" --out "$WORK/s2" -- scripts/eval-fixtures/flaky/always-fail.test.mjs scripts/eval-fixtures/flaky/stable.test.mjs 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "2" "常時失敗のみで exit 2"
assert_contains "$OUT" "揺れるテスト（flaky）: 0 件" "flaky は 0 件"
assert_contains "$OUT" "毎回落ちるテスト（揺れではなくバグ）: 1 件" "常時失敗 1 件"
assert_contains "$OUT" "always-fail.test.mjs" "常時失敗を名指し"

echo "=== scenario 3: 毎回通るだけなら exit 0 ==="
set +e
OUT="$(cd "$REPO_ROOT" && bash "$CHECK" --runs 2 --config "$FIXTURE_CONFIG" --out "$WORK/s3" -- scripts/eval-fixtures/flaky/stable.test.mjs 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "0" "揺れなしで exit 0"
assert_contains "$OUT" "結果: 常時失敗なし" "結果行"
# WHY(2026-09-07): 以前は「結果: 揺れなし・常時失敗なし」とだけ出していた。
#      判定は passed > 0 かつ failed > 0 なので、1 回あたり p で揺れるテストを N 回で
#      捕まえられる確率は 1 - p^N - (1-p)^N。**N=3 ではコイン投げの揺れですら 25% 見逃す**。
#      その数字を出さずに「揺れなし」と書くと、読み手は「揺れが無い」と受け取る
#      （同じ日に p ≈ 5〜10% の揺れが実在したのに 5 回の実行では出なかった）。
assert_contains "$OUT" "回では見つからなかった" "「見つからなかった」であって「無い」ではないと書く"
assert_contains "$OUT" "検知力" "この回数の検知力を出す"

echo "=== scenario 3b: 検知力の数字が回数によって変わる（固定文でない） ==="
set +e
OUT2="$(cd "$REPO_ROOT" && bash "$CHECK" --runs 3 --config "$FIXTURE_CONFIG" --out "$WORK/s3b" -- scripts/eval-fixtures/flaky/stable.test.mjs 2>&1)"
set -e
# N=2 の最大は 50%、N=3 の最大は 75%（1 - 2*0.5^N）
assert_contains "$OUT" "最大でも 50%" "N=2 の検知力"
assert_contains "$OUT2" "最大でも 75%" "N=3 の検知力"

echo "=== scenario 3c: 同じ回にまとまって落ちたら環境事故として括る（exit 4） ==="
# WHY(2026-09-07 の実データ): 統合テストを 10 回回したら「揺れるテスト 35 件」と出たが、
#      実際は**2 回目の実行だけでまとめて落ちた 1 件の環境事故**だった
#      （ローカル Supabase の Auth が不調。"Database error querying schema" 等）。
#      35 件の独立した揺れとして報告すると、直す先を 35 個探すことになる。
mkdir -p "$WORK/s3c"
# 3 回分のレポートを作る。2 回目だけ 6 件が落ちる（閾値 5 件以上）
make_report() {
  local out="$1" failing="$2" n
  local rows=""
  for n in 1 2 3 4 5 6; do
    if [ "$failing" = "yes" ]; then
      rows="$rows{\"fullName\":\"t$n\",\"status\":\"failed\",\"failureMessages\":[\"Database error querying schema\"]},"
    else
      rows="$rows{\"fullName\":\"t$n\",\"status\":\"passed\",\"failureMessages\":[]},"
    fi
  done
  printf '{"testResults":[{"name":"/x/env.test.ts","status":"passed","assertionResults":[%s]}]}\n' "${rows%,}" > "$out"
}
make_report "$WORK/s3c/run-1.json" no
make_report "$WORK/s3c/run-2.json" yes
make_report "$WORK/s3c/run-3.json" no
set +e
OUT="$(cd "$REPO_ROOT" && node "$AGG" "$WORK/s3c/run-1.json" "$WORK/s3c/run-2.json" "$WORK/s3c/run-3.json" 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "4" "環境事故のみなら exit 4（揺れの 1 とは分ける）"
assert_contains "$OUT" "揺れるテスト（flaky）: 0 件" "揺れとしては数えない"
assert_contains "$OUT" "環境事故とみられるもの: 6 件" "環境事故としてまとめる"
assert_contains "$OUT" "2 回目だけでまとめて落ちている" "どの回かを名指しする"

echo "=== scenario 3d: 閾値未満なら普通の揺れとして扱う（括りすぎない） ==="
mkdir -p "$WORK/s3d"
printf '{"testResults":[{"name":"/x/a.test.ts","status":"passed","assertionResults":[{"fullName":"t1","status":"passed","failureMessages":[]},{"fullName":"t2","status":"passed","failureMessages":[]}]}]}\n' > "$WORK/s3d/run-1.json"
printf '{"testResults":[{"name":"/x/a.test.ts","status":"passed","assertionResults":[{"fullName":"t1","status":"failed","failureMessages":["boom"]},{"fullName":"t2","status":"failed","failureMessages":["boom"]}]}]}\n' > "$WORK/s3d/run-2.json"
set +e
OUT="$(cd "$REPO_ROOT" && node "$AGG" "$WORK/s3d/run-1.json" "$WORK/s3d/run-2.json" 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "1" "2 件だけなら揺れとして exit 1"
assert_contains "$OUT" "揺れるテスト（flaky）: 2 件" "括らずに揺れとして出す"
assert_contains "$OUT" "環境事故とみられるもの: 0 件" "環境事故にはしない"

echo "=== scenario 4: 集計の境界（レポート不読・ファイル全体の失敗・引数不正） ==="
mkdir -p "$WORK/s4"
printf 'not json' > "$WORK/s4/broken.json"
set +e
OUT="$(cd "$REPO_ROOT" && node "$AGG" "$WORK/s4/broken.json" 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "3" "レポートが 1 つも読めなければ exit 3"
cat > "$WORK/s4/run-1.json" <<'EOF'
{"testResults":[{"name":"/x/a.test.ts","status":"failed","message":"SyntaxError: boom","assertionResults":[]}]}
EOF
cat > "$WORK/s4/run-2.json" <<'EOF'
{"testResults":[{"name":"/x/a.test.ts","status":"passed","assertionResults":[{"fullName":"a t1","status":"passed","failureMessages":[]}]}]}
EOF
set +e
OUT="$(cd "$REPO_ROOT" && node "$AGG" --json "$WORK/s4/broken.json" "$WORK/s4/run-1.json" "$WORK/s4/run-2.json" 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "2" "ファイル全体の読み込み失敗は常時失敗として数える（他の run では鍵が違うので混在にならない）"
assert_contains "$OUT" '"runs": 2' "読めたレポートだけを runs に数える"
assert_contains "$OUT" '(ファイル全体)' "ファイル全体の失敗を鍵にする"
assert_contains "$OUT" 'broken.json' "読めなかったレポートを列挙"
set +e
OUT="$(cd "$REPO_ROOT" && bash "$CHECK" --runs abc 2>&1)"
STATUS=$?
set -e
assert_eq "$STATUS" "3" "--runs が整数でなければ exit 3"

echo "=== scenario 5: 通常の npm test が fixture を拾わない（fixture が本番のテストを揺らさない） ==="
if grep -q "scripts/eval-fixtures" "$REPO_ROOT/vitest.config.ts"; then
  assert_ok "vitest.config.ts が scripts/eval-fixtures を除外"
else
  assert_fail "vitest.config.ts が scripts/eval-fixtures を除外していない"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
