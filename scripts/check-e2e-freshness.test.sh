#!/usr/bin/env bash
set -uo pipefail

# WHY: 警告を出すはずの hook が無言で死ぬ（fail-open）のが一番こわい。
#      この検査は E-060（E2E が 1 日以上赤のまま誰にも見られていなかった）を二度と起こさないためのもので、
#      **これ自体が黙ると、赤に気づく手段がまた無くなる**。
#      4 つの警告条件それぞれについて**実際に警告文が出ること**と、正常時に**何も出ないこと**を測る。
#      統合テスト版（check-integration-freshness.test.sh）と対になっている。
#
# 実行: bash scripts/check-e2e-freshness.test.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-e2e-freshness.sh"

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

E2E_TREE="$(git rev-parse "HEAD:e2e" 2>/dev/null || echo unknown)"
SRC_TREE="$(git rev-parse "HEAD:src" 2>/dev/null || echo unknown)"
if [ "$E2E_TREE" = "unknown" ]; then
  echo "e2e/ が無いので検査対象外（この検査自体をスキップ）"
  exit 0
fi

run_check() {
  AIDD_LOG_DIR="$WORK" bash "$CHECK" 2>&1
}

write_log() {
  printf '%s\n' "$1" > "$WORK/e2e-runs.jsonl"
}

green_row() { # $1=e2eTree $2=srcTree $3=e2eDirty $4=srcDirty
  printf '{"at":"2026-09-08T00:00:00Z","result":"pass","exitCode":0,"e2eTree":"%s","srcTree":"%s","commit":"abc1234","branch":"x","e2eDirty":%s,"srcDirty":%s}' \
    "$1" "$2" "$3" "$4"
}

echo "=== scenario 1: 記録が 1 件も無い ==="
rm -f "$WORK/e2e-runs.jsonl"
OUT="$(run_check)"
contains "$OUT" "記録が 1 件もありません" "一度も回していないことを警告する"
contains "$OUT" "run-e2e-tests.sh" "回し方を案内する"

echo "=== scenario 2: 直近が失敗 ==="
write_log "{\"at\":\"2026-09-08T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"e2eTree\":\"$E2E_TREE\",\"srcTree\":\"$SRC_TREE\",\"commit\":\"abc1234\",\"branch\":\"x\",\"e2eDirty\":false,\"srcDirty\":false}"
OUT="$(run_check)"
contains "$OUT" "失敗" "赤のまま放置されていることを警告する"

echo "=== scenario 3: e2e/ が記録時から変わっている ==="
write_log "$(green_row "0000000000000000000000000000000000000000" "$SRC_TREE" false false)"
OUT="$(run_check)"
contains "$OUT" "変わっています" "spec が動いたら記録を当てにしない"
contains "$OUT" 'e2e/' "どちらが変わったかを名指しする"

echo "=== scenario 4: src/ が記録時から変わっている（E2E が守るのは画面の振る舞い） ==="
write_log "$(green_row "$E2E_TREE" "0000000000000000000000000000000000000000" false false)"
OUT="$(run_check)"
contains "$OUT" "変わっています" "プロダクトコードが動いたら記録を当てにしない"
contains "$OUT" 'src/' "src/ を名指しする"

echo "=== scenario 5: 未コミットの変更がある状態での実行 ==="
write_log "$(green_row "$E2E_TREE" "$SRC_TREE" false true)"
OUT="$(run_check)"
contains "$OUT" "未コミット" "汚れた木での合格は証拠にしない"

echo "=== scenario 6: 同じ木で通っていれば何も言わない ==="
write_log "$(green_row "$E2E_TREE" "$SRC_TREE" false false)"
OUT="$(run_check)"
is_empty "$OUT" "正常時は無言（警告疲れを作らない）"

echo "=== scenario 7: 壊れた行しか無い記録 ==="
write_log "これは JSON ではない"
OUT="$(run_check)"
contains "$OUT" "読める行がありません" "記録が壊れていたら黙って合格にしない"

echo "=== scenario 8: 最後の 1 行を見る（途中の失敗で警告し続けない） ==="
{
  echo "{\"at\":\"2026-09-07T00:00:00Z\",\"result\":\"fail\",\"exitCode\":1,\"e2eTree\":\"$E2E_TREE\",\"srcTree\":\"$SRC_TREE\",\"commit\":\"a\",\"branch\":\"x\",\"e2eDirty\":false,\"srcDirty\":false}"
  green_row "$E2E_TREE" "$SRC_TREE" false false
  echo ""
} > "$WORK/e2e-runs.jsonl"
OUT="$(run_check)"
is_empty "$OUT" "直したあとは鳴り止む"

echo "=== scenario 9: 記録するのは全件を通したときだけ（部分実行は記録しない） ==="
# WHY: `--grep` や spec 名を渡した実行を記録すると、次のセッションが嘘の緑を信じる
RUNNER="$SCRIPT_DIR/run-e2e-tests.sh"
if grep -q 'if \[ "\$#" -ne 0 \]; then' "$RUNNER"; then
  echo "  OK: 引数付きの実行では記録しない分岐がある"
  pass_count=$((pass_count + 1))
else
  echo "  NG: 引数付きの実行でも記録してしまう"
  fail=1
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED（$pass_count 件）"
