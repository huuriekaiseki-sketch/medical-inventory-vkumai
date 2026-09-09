#!/usr/bin/env bash
set -uo pipefail

# WHY(2026-09-10): 警告を出すはずの hook が無言で死ぬ（fail-open）のが一番こわい。
#      製品コードの変異計測（Stryker）は人が打たないと動かないので、
#      **この検査が黙ると、下限を割ったことにも「対象を減らしてスコアが上がった」ことにも
#      気づく手段が無くなる**。警告条件それぞれで**実際に文が出ること**と、
#      正常時に**何も出ないこと**を測る。RLS 版・統合テスト版・E2E 版と 4 つ目の対。
#      あわせて、記録側（run-mutation-tests.sh）が**古いレポートを今回のスコアとして拾わない**
#      ことも測る（2026-09-10 に実際に踏みかけた。C-010）。
#
# 実行: bash scripts/check-mutation-freshness.test.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHECK="$SCRIPT_DIR/check-mutation-freshness.sh"

fail=0
pass_count=0

contains() {
  if printf '%s' "$1" | grep -q "$2"; then
    echo "  OK: $3"
    pass_count=$((pass_count + 1))
  else
    echo "  NG: $3"
    echo "    出力: $1"
    fail=1
  fi
}

is_empty() {
  if [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]; then
    echo "  OK: $2"
    pass_count=$((pass_count + 1))
  else
    echo "  NG: $2"
    echo "    出力: $1"
    fail=1
  fi
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"
CONFIG_TREE="$(git rev-parse "HEAD:stryker.config.json" 2>/dev/null || echo unknown)"
if [ "$SRC_TREE" = "unknown" ]; then
  echo "src/ が無いので検査対象外（この検査自体をスキップ）"
  exit 0
fi

run_check() {
  AIDD_LOG_DIR="$WORK" bash "$CHECK" 2>&1
}

write_log() {
  printf '%s\n' "$1" > "$WORK/mutation-runs.jsonl"
}

green_row() { # $1=srcTree $2=strykerTree $3=srcDirty $4=strykerDirty
  printf '{"at":"2026-09-10T00:00:00Z","result":"pass","exitCode":0,"score":92.87,"srcTree":"%s","strykerTree":"%s","commit":"abc1234","branch":"x","srcDirty":%s,"strykerDirty":%s}' \
    "$1" "$2" "$3" "$4"
}

# 「いまの姿」まで含めた記録（C-041）。srcWorktree / strykerWorktree を持つ新しい形。
green_row_wt() { # $1=srcTree $2=strykerTree $3=srcWorktree $4=strykerWorktree
  printf '{"at":"2026-09-10T00:00:00Z","result":"pass","exitCode":0,"score":92.87,"srcTree":"%s","strykerTree":"%s","commit":"abc1234","branch":"x","srcDirty":false,"strykerDirty":false,"srcWorktree":"%s","strykerWorktree":"%s"}' \
    "$1" "$2" "$3" "$4"
}

echo "=== scenario 1: 記録が 1 件も無い ==="
rm -f "$WORK/mutation-runs.jsonl"
OUT="$(run_check)"
contains "$OUT" "記録が 1 件もありません" "一度も回していないことを警告する"
contains "$OUT" "run-mutation-tests.sh" "回し方を案内する"

echo "=== scenario 2: 直近が失敗（下限を割った） ==="
write_log "{\"at\":\"2026-09-10T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"score\":88.0,\"srcTree\":\"$SRC_TREE\",\"strykerTree\":\"$CONFIG_TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"srcDirty\":false,\"strykerDirty\":false}"
OUT="$(run_check)"
contains "$OUT" "失敗" "下限割れを放置していることを警告する"

echo "=== scenario 3: src/ が記録時から変わっている ==="
write_log "$(green_row "0000000000000000000000000000000000000000" "$CONFIG_TREE" false false)"
OUT="$(run_check)"
contains "$OUT" "変わっています" "認可の判断が動いたら記録を当てにしない"
contains "$OUT" 'src/' "src/ を名指しする"

echo "=== scenario 4: 対象の一覧（stryker.config.json）が変わっている ==="
# WHY: **対象を減らせばスコアは上がる**。src/ が同じでも一覧が変われば前の記録は当てにならない
write_log "$(green_row "$SRC_TREE" "0000000000000000000000000000000000000000" false false)"
OUT="$(run_check)"
contains "$OUT" "変わっています" "測る対象が動いたら記録を当てにしない"
contains "$OUT" 'stryker' "対象の一覧を名指しする"

echo "=== scenario 5: 未コミットの変更がある状態での実行 ==="
write_log "$(green_row "$SRC_TREE" "$CONFIG_TREE" true false)"
OUT="$(run_check)"
contains "$OUT" "未コミット" "汚れた木での合格は証拠にしない"

echo "=== scenario 6: 同じ木で通っていれば何も言わない ==="
write_log "$(green_row "$SRC_TREE" "$CONFIG_TREE" false false)"
OUT="$(run_check)"
is_empty "$OUT" "正常時は無言（警告疲れを作らない）"

echo "=== scenario 7: 壊れた行しか無い記録 ==="
write_log "これは JSON ではない"
OUT="$(run_check)"
contains "$OUT" "読める行がありません" "記録が壊れていたら黙って合格にしない"

echo "=== scenario 8: 最後の 1 行を見る（途中の失敗で警告し続けない） ==="
{
  echo "{\"at\":\"2026-09-09T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"score\":88.0,\"srcTree\":\"$SRC_TREE\",\"strykerTree\":\"$CONFIG_TREE\",\"commit\":\"a\",\"branch\":\"x\",\"srcDirty\":false,\"strykerDirty\":false}"
  green_row "$SRC_TREE" "$CONFIG_TREE" false false
  echo ""
} > "$WORK/mutation-runs.jsonl"
OUT="$(run_check)"
is_empty "$OUT" "直したあとは鳴り止む"

echo "=== scenario 9: 記録するのは全件を通したときだけ（部分実行は記録しない） ==="
RUNNER="$SCRIPT_DIR/run-mutation-tests.sh"
if grep -q 'if \[ "\$#" -ne 0 \]; then' "$RUNNER"; then
  echo "  OK: 引数付きの実行では記録しない分岐がある"
  pass_count=$((pass_count + 1))
else
  echo "  NG: 引数付きの実行でも記録してしまう"
  fail=1
fi

echo "=== scenario 10: 設定が無い導入先では黙る ==="
# WHY: 変異の計測を入れていないリポジトリで言い続けても直しようがない。
#      **言わない側も測らないと、「常に言う」実装でも 1〜5 は通ってしまう**
CONFIG="$REPO_ROOT/stryker.config.json"
HIDDEN="$WORK/stryker.config.json.hidden"
if [ -f "$CONFIG" ]; then
  rm -f "$WORK/mutation-runs.jsonl"
  mv "$CONFIG" "$HIDDEN"
  OUT="$(run_check)"
  mv "$HIDDEN" "$CONFIG"
  is_empty "$OUT" "設定が無ければ何も言わない"
else
  echo "  NG: stryker.config.json が見つからない（${CONFIG}）"
  fail=1
fi

echo "=== scenario 11: 古いレポートを「今回のスコア」として記録しない ==="
# WHY(2026-09-10 に実際に踏みかけた): `reports/mutation/mutation.json` は json レポーターが
#      外れていた間、**2026-09-07 の実行のまま**残っていた。そのまま読むと違う数字を
#      「今回の結果」として記録する（C-010）。走り出した時刻より古い出力は採らない。
STALE_WORK="$WORK/stale"
mkdir -p "$STALE_WORK/reports/mutation" "$STALE_WORK/logs" "$STALE_WORK/scripts/lib"
cp "$SCRIPT_DIR/lib/resolve-log-dir.sh" "$SCRIPT_DIR/lib/worktree-hash.sh" "$STALE_WORK/scripts/lib/"
cp "$SCRIPT_DIR/run-mutation-tests.sh" "$STALE_WORK/scripts/"
cat > "$STALE_WORK/reports/mutation/mutation.json" <<'JSON'
{"files": {"a.ts": {"mutants": [{"status": "Killed"}, {"status": "Killed"}, {"status": "Survived"}]}}}
JSON
# 出力を「1 時間前」にして、実行より古い状態を作る
touch -t "$(date -v-1H '+%Y%m%d%H%M' 2>/dev/null || date -d '1 hour ago' '+%Y%m%d%H%M')" \
  "$STALE_WORK/reports/mutation/mutation.json"
cat > "$STALE_WORK/fake-stryker" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$STALE_WORK/fake-stryker"
(
  cd "$STALE_WORK" || exit 1
  AIDD_LOG_DIR="$STALE_WORK/logs" RMT_STRYKER_BIN="$STALE_WORK/fake-stryker" \
    bash "$STALE_WORK/scripts/run-mutation-tests.sh" >/dev/null 2>&1
)
STALE_ROW="$(tail -n1 "$STALE_WORK/logs/mutation-runs.jsonl" 2>/dev/null || echo '')"
contains "$STALE_ROW" '"score": null' "古い出力のスコアは採らない（null で残す）"
contains "$STALE_ROW" '"result": "pass"' "スコアが読めなくても実行の記録そのものは残す"

echo "=== scenario 13: 未コミットの書き換えを見る（C-041） ==="
# WHY(2026-09-10): 記録側は最初から srcWorktree を残していたのに、判定側が --worktree を
#      渡しておらず、**手元で認可の判断を書き換えても記録と一致してしまう**
#      （HEAD の木のハッシュは変わらないため）。測る対象の一覧も同じで、
#      **手元で mutate を減らせばスコアは上がる**ので stryker.config.json も見る。
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"
SRC_WT="$(worktree_hash src)"
CONFIG_WT="$(worktree_hash stryker.config.json)"

write_log "$(green_row_wt "$SRC_TREE" "$CONFIG_TREE" "0000000000000000000000000000000000000000" "$CONFIG_WT")"
OUT="$(run_check)"
contains "$OUT" "いまの" "src/ の未コミットの書き換えを検知する"
contains "$OUT" "単体のテストだけを緑にして終えていないか" "C-041 の言葉で伝える"

write_log "$(green_row_wt "$SRC_TREE" "$CONFIG_TREE" "$SRC_WT" "0000000000000000000000000000000000000000")"
OUT="$(run_check)"
contains "$OUT" "いまの" "測る対象の一覧の未コミットの書き換えも検知する"

write_log "$(green_row_wt "$SRC_TREE" "$CONFIG_TREE" "$SRC_WT" "$CONFIG_WT")"
OUT="$(run_check)"
is_empty "$OUT" "いまの姿と一致していれば黙る（対照）"

echo "=== scenario 12: 実行はラッパー経由になっている（素の stryker を打たせない） ==="
# WHY: package.json が素の `stryker run` のままだと、打っても記録が残らない。
#      **記録の仕組みを作っても、入口が別なら誰も通らない**
if grep -q 'run-mutation-tests.sh' "$REPO_ROOT/package.json"; then
  echo "  OK: npm script がラッパーを呼ぶ"
  pass_count=$((pass_count + 1))
else
  echo "  NG: npm script が素の stryker を呼んでいる（打っても記録が残らない）"
  fail=1
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
