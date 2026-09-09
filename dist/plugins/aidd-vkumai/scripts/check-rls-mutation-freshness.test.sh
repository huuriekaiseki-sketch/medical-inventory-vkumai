#!/usr/bin/env bash
set -uo pipefail

# WHY(2026-09-10): 警告を出すはずの hook が無言で死ぬ（fail-open）のが一番こわい。
#      この検査は「RLS の変異計測を、ポリシーが変わったのに回していない」を拾うためのもので、
#      **これ自体が黙ると、守っていないテストがあることに気づく手段がまた無くなる**。
#      警告条件それぞれについて**実際に警告文が出ること**と、正常時に**何も出ないこと**を測る。
#      統合テスト版・E2E 版と 3 つ目の対になっている（判定は共有の run-freshness.py）。
#
# 実行: bash scripts/check-rls-mutation-freshness.test.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-rls-mutation-freshness.sh"

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

SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"
if [ "$SUPABASE_TREE" = "unknown" ]; then
  echo "supabase/ が無いので検査対象外（この検査自体をスキップ）"
  exit 0
fi

run_check() {
  AIDD_LOG_DIR="$WORK" bash "$CHECK" 2>&1
}

write_log() {
  printf '%s\n' "$1" > "$WORK/rls-mutation-runs.jsonl"
}

green_row() { # $1=supabaseTree $2=supabaseDirty
  printf '{"at":"2026-09-10T00:00:00Z","result":"pass","exitCode":0,"killed":18,"survived":0,"errors":0,"supabaseTree":"%s","commit":"abc1234","branch":"x","supabaseDirty":%s}' \
    "$1" "$2"
}

# 「いまの姿」まで含めた記録（C-041）。supabaseWorktree を持つ新しい形。
green_row_wt() { # $1=supabaseTree $2=supabaseWorktree
  printf '{"at":"2026-09-10T00:00:00Z","result":"pass","exitCode":0,"killed":18,"survived":0,"errors":0,"supabaseTree":"%s","commit":"abc1234","branch":"x","supabaseDirty":false,"supabaseWorktree":"%s"}' \
    "$1" "$2"
}

echo "=== scenario 1: 記録が 1 件も無い ==="
rm -f "$WORK/rls-mutation-runs.jsonl"
OUT="$(run_check)"
contains "$OUT" "記録が 1 件もありません" "一度も回していないことを警告する"
contains "$OUT" "check-rls-mutation.sh" "回し方を案内する"

echo "=== scenario 2: 直近が失敗（生き残った変異がある） ==="
write_log "{\"at\":\"2026-09-10T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"killed\":17,\"survived\":1,\"errors\":0,\"supabaseTree\":\"$SUPABASE_TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"supabaseDirty\":false}"
OUT="$(run_check)"
contains "$OUT" "失敗" "生き残りを放置していることを警告する"

echo "=== scenario 3: supabase/ が記録時から変わっている ==="
write_log "$(green_row "0000000000000000000000000000000000000000" false)"
OUT="$(run_check)"
contains "$OUT" "変わっています" "ポリシーが動いたら記録を当てにしない"
contains "$OUT" 'supabase/' "何が変わったかを名指しする"

echo "=== scenario 4: 未コミットの変更がある状態での実行 ==="
write_log "$(green_row "$SUPABASE_TREE" true)"
OUT="$(run_check)"
contains "$OUT" "未コミット" "汚れた木での合格は証拠にしない"

echo "=== scenario 5: 同じ木で通っていれば何も言わない ==="
write_log "$(green_row "$SUPABASE_TREE" false)"
OUT="$(run_check)"
is_empty "$OUT" "正常時は無言（警告疲れを作らない）"

echo "=== scenario 6: 壊れた行しか無い記録 ==="
write_log "これは JSON ではない"
OUT="$(run_check)"
contains "$OUT" "読める行がありません" "記録が壊れていたら黙って合格にしない"

echo "=== scenario 7: 最後の 1 行を見る（途中の失敗で警告し続けない） ==="
{
  echo "{\"at\":\"2026-09-09T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"killed\":17,\"survived\":1,\"errors\":0,\"supabaseTree\":\"$SUPABASE_TREE\",\"commit\":\"a\",\"branch\":\"x\",\"supabaseDirty\":false}"
  green_row "$SUPABASE_TREE" false
  echo ""
} > "$WORK/rls-mutation-runs.jsonl"
OUT="$(run_check)"
is_empty "$OUT" "直したあとは鳴り止む"

echo "=== scenario 8: 記録するのは全件を通したときだけ（部分実行は記録しない） ==="
# WHY: ID を 1 つ渡した実行を記録すると、次のセッションが嘘の緑を信じる
RUNNER="$SCRIPT_DIR/check-rls-mutation.sh"
if grep -q 'if \[ "\$#" -ne 0 \]; then' "$RUNNER"; then
  echo "  OK: 引数付きの実行では記録しない分岐がある"
  pass_count=$((pass_count + 1))
else
  echo "  NG: 引数付きの実行でも記録してしまう"
  fail=1
fi

echo "=== scenario 10: 未コミットの書き換えを見る（C-041） ==="
# WHY(2026-09-10): 記録側は最初から supabaseWorktree を残していたのに、判定側が
#      --worktree を渡しておらず、**手元でポリシーを書き換えても記録と一致してしまう**
#      （HEAD の木のハッシュは変わらないため）。この 2 件が「渡している」ことの実測。
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"
SUPABASE_WT="$(worktree_hash supabase)"
write_log "$(green_row_wt "$SUPABASE_TREE" "0000000000000000000000000000000000000000")"
OUT="$(run_check)"
contains "$OUT" "いまの" "いまの姿では通していないと言う"
contains "$OUT" "単体のテストだけを緑にして終えていないか" "C-041 の言葉で伝える"

write_log "$(green_row_wt "$SUPABASE_TREE" "$SUPABASE_WT")"
OUT="$(run_check)"
is_empty "$OUT" "いまの姿と一致していれば黙る（対照）"

echo "=== scenario 9: 壊し方の登録簿が無い導入先では黙る ==="
# WHY: 変異の計測を入れていないリポジトリで「一度も回していない」と言い続けても直しようがない。
#      登録簿を一時的に隠して、無言になることを実測する（**言わない側も測らないと、
#      「常に言う」実装でも scenario 1〜4 は通ってしまう**）
REG="$SCRIPT_DIR/lib/rls-mutants.json"
HIDDEN="$WORK/rls-mutants.json.hidden"
if [ -f "$REG" ]; then
  rm -f "$WORK/rls-mutation-runs.jsonl"
  mv "$REG" "$HIDDEN"
  OUT="$(run_check)"
  mv "$HIDDEN" "$REG"
  is_empty "$OUT" "登録簿が無ければ何も言わない"
else
  echo "  NG: 壊し方の登録簿が見つからない（${REG}）"
  fail=1
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
