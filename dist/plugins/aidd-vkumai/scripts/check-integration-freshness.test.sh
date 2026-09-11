#!/usr/bin/env bash
set -uo pipefail

# WHY: 警告を出すはずの hook が無言で死ぬ（fail-open）のが一番こわい。
#      2026-09-05 の hook 実走ドリルでは、実データで動かして初めて 7 件の無音死が見つかった。
#      ここでは 4 つの警告条件それぞれについて、**実際に警告文が出ること**と、
#      正常時に**何も出ないこと**の両方を測る。

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-integration-freshness.sh"

fail=0
pass_count=0

contains() {
  if grep -q "$2" <<<"$1"; then
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

TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"
if [ "$TREE" = "unknown" ]; then
  echo "supabase/ が無いので検査対象外（この検査自体をスキップ）"
  exit 0
fi

run_check() {
  AIDD_LOG_DIR="$WORK" bash "$CHECK" 2>&1
}

write_log() {
  printf '%s\n' "$1" > "$WORK/integration-runs.jsonl"
}

echo "=== scenario 1: 記録が 1 件も無い ==="
rm -f "$WORK/integration-runs.jsonl"
OUT="$(run_check)"
contains "$OUT" "記録が 1 件もありません" "一度も回していないことを警告する"

echo "=== scenario 2: 直近が失敗 ==="
write_log "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"supabaseTree\":\"$TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"supabaseDirty\":false}"
OUT="$(run_check)"
contains "$OUT" "失敗" "赤のまま放置されていることを警告する"

echo "=== scenario 3: supabase/ が記録時から変わっている ==="
write_log "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"pass\",\"exitCode\":0,\"supabaseTree\":\"0000000000000000000000000000000000000000\",\"commit\":\"abc1234\",\"branch\":\"x\",\"supabaseDirty\":false}"
OUT="$(run_check)"
contains "$OUT" "変わっています" "木が変わったら記録を当てにしない"

echo "=== scenario 4: 未コミットの変更がある状態での実行 ==="
write_log "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"pass\",\"exitCode\":0,\"supabaseTree\":\"$TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"supabaseDirty\":true}"
OUT="$(run_check)"
contains "$OUT" "未コミット" "汚れた木での合格は証拠にしない"

echo "=== scenario 5: 同じ木で通っていれば何も言わない ==="
write_log "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"pass\",\"exitCode\":0,\"supabaseTree\":\"$TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"supabaseDirty\":false}"
OUT="$(run_check)"
is_empty "$OUT" "正常時は無言（警告疲れを作らない）"

echo "=== scenario 6: 壊れた行しか無い記録 ==="
write_log "これは JSON ではない"
OUT="$(run_check)"
contains "$OUT" "読める行がありません" "記録が壊れていたら黙って合格にしない"

echo "=== scenario 7: 最後の 1 行を見る（途中の失敗で警告し続けない） ==="
{
  echo "{\"at\":\"2026-09-06T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"supabaseTree\":\"$TREE\",\"commit\":\"a\",\"branch\":\"x\",\"supabaseDirty\":false}"
  echo "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"pass\",\"exitCode\":0,\"supabaseTree\":\"$TREE\",\"commit\":\"b\",\"branch\":\"x\",\"supabaseDirty\":false}"
} > "$WORK/integration-runs.jsonl"
OUT="$(run_check)"
is_empty "$OUT" "直したあとは鳴り止む"

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
