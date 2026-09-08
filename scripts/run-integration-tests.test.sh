#!/usr/bin/env bash
# WHY: scripts/run-integration-tests.sh の「追記専用テーブルの積み上がりを知らせる」部分の回帰テスト。
#      この警告は E-022 / E-023（消せない表が積み上がって、全件を取るテストが古い順に切り落とされ
#      「監査の取りこぼし」に見える失敗をした）を次に踏まないためのもの。**警告が静かに死ぬと、
#      その事故の再発に気づく手段がまた無くなる**ので、次の 4 つを固定する:
#
#   1. 閾値を超えた表を名指しし、作り直す手段（db reset）を案内する
#   2. 閾値以下なら黙る（毎回鳴るなら誰も読まない）
#   3. ローカル以外を向いていたら**問い合わせにも行かない**（本番の監査ログを数えに行かない）
#   4. append-only の表を migrations から実際に見つけている（空振りしていない）
#
# 実 DB は要らない。PostgREST の代わりに使い捨ての HTTP スタブを立てて測る。
#
# 実行: bash scripts/run-integration-tests.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPT="$SCRIPT_DIR/run-integration-tests.sh"

fail=0
assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then echo "  OK: $label"; else
    echo "  NG: $label"; echo "      expected to find: $needle"; echo "      actual: $haystack"; fail=1; fi
}
assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "  NG: $label"; echo "      unexpected: $needle"; echo "      actual: $haystack"; fail=1
  else echo "  OK: $label"; fi
}

WORK_DIR="$(mktemp -d)"
STUB_LOG="$WORK_DIR/stub.log"
PORT_FILE="$WORK_DIR/port"

# PostgREST の代わり。HEAD に content-range を返し、問い合わせが来たことを記録する。
# rows= で「全部の表がこの行数」と答える。
cat > "$WORK_DIR/stub.mjs" <<'NODE'
import http from 'node:http'
import fs from 'node:fs'

const rows = Number(process.argv[2])
const logPath = process.argv[3]
const portPath = process.argv[4]
const server = http.createServer((req, res) => {
  fs.appendFileSync(logPath, req.url + '\n')
  res.setHeader('content-range', `0-0/${rows}`)
  res.writeHead(206)
  res.end()
})
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portPath, String(server.address().port))
})
NODE

start_stub() { # $1=返す行数
  : > "$STUB_LOG"
  rm -f "$PORT_FILE"
  node "$WORK_DIR/stub.mjs" "$1" "$STUB_LOG" "$PORT_FILE" &
  STUB_PID=$!
  for _ in $(seq 1 50); do
    [ -s "$PORT_FILE" ] && break
    sleep 0.1
  done
  STUB_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
}
stop_stub() { kill "$STUB_PID" 2>/dev/null; wait "$STUB_PID" 2>/dev/null; }
cleanup() { stop_stub; rm -rf "$WORK_DIR"; }
trap cleanup EXIT

run_check() { # 環境を与えて警告部分だけ動かす
  RIT_ENV_FILE="" \
  RIT_PILEUP_THRESHOLD="$1" \
  NEXT_PUBLIC_SUPABASE_URL="$2" \
  SUPABASE_SERVICE_ROLE_KEY="dummy-key-not-a-secret" \
    bash "$SCRIPT" --check-pileup-only 2>/dev/null
}

echo "=== scenario 1: 閾値を超えたら表を名指しし、作り直す手段を案内する ==="
start_stub 1200
if [ -z "${STUB_PORT:-}" ]; then
  echo "  NG: スタブが起動しない"; fail=1
else
  OUT="$(run_check 800 "http://127.0.0.1:$STUB_PORT")"
  assert_contains "$OUT" "積み上がっています" "積み上がりを知らせる"
  assert_contains "$OUT" "audit_log=1200 行" "表の名前と行数を出す"
  assert_contains "$OUT" "access_denials=1200 行" "同じ形の他の表も出す"
  assert_contains "$OUT" "db reset" "作り直す手段を案内する"
  assert_contains "$OUT" "E-022" "同じ型の過去の事故を指す"
fi
stop_stub

echo "=== scenario 4: append-only の表を migrations から実際に見つけている（空振り防止） ==="
# WHY: 表を 1 つも見つけられなくても、この警告は「何も出ない」だけで正常に見える。
#      問い合わせ先の URL を数えて、実際に複数の表を当たったことを確かめる。
start_stub 1200
if [ -n "${STUB_PORT:-}" ]; then
  run_check 800 "http://127.0.0.1:$STUB_PORT" > /dev/null
  ASKED="$(sort -u "$STUB_LOG" | grep -c . || true)"
  if [ "$ASKED" -ge 3 ]; then
    echo "  OK: $ASKED 個の表を実際に当たっている"
  else
    echo "  NG: 当たった表が $ASKED 個しかない（migrations から見つけられていない）"; fail=1
  fi
  assert_contains "$(cat "$STUB_LOG")" "/rest/v1/audit_log" "audit_log を当たっている"
  assert_contains "$(cat "$STUB_LOG")" "/rest/v1/privileged_operations" "privileged_operations を当たっている"
fi
stop_stub

echo "=== scenario 2: 閾値以下なら黙る ==="
start_stub 10
if [ -n "${STUB_PORT:-}" ]; then
  OUT="$(run_check 800 "http://127.0.0.1:$STUB_PORT")"
  assert_not_contains "$OUT" "積み上がっています" "少なければ何も言わない"
fi
stop_stub

echo "=== scenario 3: ローカル以外を向いていたら問い合わせにも行かない ==="
start_stub 1200
if [ -n "${STUB_PORT:-}" ]; then
  # 127.0.0.1 のスタブを、ローカルでないホスト名（の見た目）で指す。
  # 名前解決は起きない想定だが、起きても問い合わせ 0 件であることを見る。
  OUT="$(run_check 800 "https://example.supabase.co")"
  assert_not_contains "$OUT" "積み上がっています" "本番向きなら何も言わない"
  ASKED="$(grep -c . "$STUB_LOG" || true)"
  if [ "$ASKED" -eq 0 ]; then
    echo "  OK: 問い合わせを 1 件も出していない"
  else
    echo "  NG: 本番向きなのに $ASKED 件の問い合わせを出した"; fail=1
  fi
fi
stop_stub

echo "=== scenario 5: --check-pileup-only は統合テストを実行しない（exit 0 で終わる） ==="
start_stub 10
if [ -n "${STUB_PORT:-}" ]; then
  run_check 800 "http://127.0.0.1:$STUB_PORT" > /dev/null
  CODE=$?
  if [ "$CODE" -eq 0 ]; then echo "  OK: exit 0"; else echo "  NG: exit $CODE"; fail=1; fi
  if [ -f "$REPO_ROOT/logs/integration-runs.jsonl" ]; then
    LAST_AT="$(tail -n1 "$REPO_ROOT/logs/integration-runs.jsonl" 2>/dev/null)"
    assert_not_contains "$LAST_AT" '"result": "pass"' "警告だけの実行を「統合テストを通した」として記録しない"
  else
    echo "  OK: 実行の記録を作っていない"
  fi
fi
stop_stub

echo "=== scenario 6: 部分実行は記録しない・全件実行だけ記録する（両方向） ==="
# WHY: 「1 本だけ通した」を「全件通した」として記録すると、check-integration-freshness.sh が
#      嘘の緑を信じる。このスクリプトが作られたきっかけ（赤 2 件が長期間気づかれなかった）を
#      そのまま再現できてしまう。**記録する側／しない側の両方**を測らないと、
#      「常に記録しない」実装でも緑になる。
REC_DIR="$WORK_DIR/logs"
REC_LOG="$REC_DIR/integration-runs.jsonl"
cat > "$WORK_DIR/fake-vitest" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$WORK_DIR/fake-vitest"

run_recorded() { # $@ = run-integration-tests.sh に渡す引数
  rm -rf "$REC_DIR"
  RIT_ENV_FILE="" \
  RIT_PILEUP_THRESHOLD="" \
  AIDD_LOG_DIR="$REC_DIR" \
  RIT_VITEST_BIN="$WORK_DIR/fake-vitest" \
    bash "$SCRIPT" "$@" 2>/dev/null
}

OUT="$(run_recorded supabase/__tests__/integration/business-invariants.integration.test.ts)"
assert_contains "$OUT" "記録しません" "引数付きなら記録しないと言う"
if [ -s "$REC_LOG" ]; then
  echo "  NG: 部分実行なのに記録した: $(cat "$REC_LOG")"; fail=1
else
  echo "  OK: 部分実行では 1 行も記録していない"
fi

OUT="$(run_recorded)"
assert_not_contains "$OUT" "記録しません" "引数無しでは記録を止めない"
if [ -s "$REC_LOG" ]; then
  assert_contains "$(cat "$REC_LOG")" '"result": "pass"' "全件実行なら記録する（対照）"
else
  echo "  NG: 全件実行なのに記録していない（常に記録しない実装になっている）"; fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
