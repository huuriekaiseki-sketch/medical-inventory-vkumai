#!/bin/bash
# WHY: eval-sweep-recall.sh は claude -p のサブプロセス実行を含み実課金が発生するため、
# EVAL_SWEEP_RECALL_AGENT_CMD でモックに差し替えて判定ロジックを実課金なしで回帰テストする
# （eval-workflow-prompts.test.sh と同型）。issue #731 で、モデルが --json-schema を無視して素の
# テキストで返すと detail が空になり、欠陥を正しく報告していても MISS になる欠陥が見つかったため、
# その fallback（JSON でなければ生出力全体を判定対象にする）を RED/GREEN 両方向で固定する。
#
# 実行: bash scripts/eval-sweep-recall.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$SCRIPT_DIR/eval-sweep-recall.sh"

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

# --- clone 元となるダミー repo（buildSweepPrompt を含む） ---
DUMMY_REPO="$WORKDIR/dummy-repo"
mkdir -p "$DUMMY_REPO/.claude/workflows/lib/prompts" "$DUMMY_REPO/.claude/agents" "$DUMMY_REPO/docs/agents"
(
  cd "$DUMMY_REPO"
  git init -q
  git config user.email "test@example.com"
  git config user.name "test"
  echo "export function buildSweepPrompt(task, scope = 'full') { return 'task:' + task + ' scope:' + scope }" > .claude/workflows/lib/prompts/sweep.js
  printf -- '---\nname: sweep-x\ndescription: test\n---\nbody\n' > .claude/agents/sweep-x.md
  git add -A
  git commit -q -m "init"
)

# --- 最小 fixture セット ---
FIXTURES_DIR="$WORKDIR/fixtures"
mkdir -p "$FIXTURES_DIR/sweep-x/case-1/files/src/lib/probe"
echo '{ "agentType": "sweep-x", "model": "haiku" }' > "$FIXTURES_DIR/sweep-x/manifest.json"
echo "export const probe = 1" > "$FIXTURES_DIR/sweep-x/case-1/files/src/lib/probe/repository.ts"
echo '{ "expectedFilePathContains": "probe/repository.ts", "expectedKeywords": ["internalNote", "型不一致"] }' > "$FIXTURES_DIR/sweep-x/case-1/expected.json"

MOCK_AGENT="$WORKDIR/mock-agent.sh"
MOCK_RESPONSE_FILE="$WORKDIR/mock-response.txt"
cat > "$MOCK_AGENT" <<'MOCK_EOF'
#!/usr/bin/env bash
cat /dev/stdin > /dev/null
cat "$MOCK_RESPONSE_FILE"
MOCK_EOF
chmod +x "$MOCK_AGENT"

fail=0
ok() { echo "  OK: $1"; }
ng() { echo "  NG: $1"; [ -n "${2:-}" ] && echo "      $2"; fail=1; }
assert_contains() { if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else ng "$3" "expected: $2 / actual: $1"; fi; }

# WHY(AIDD_LOG_DIR を一時ディレクトリへ向ける、2026-09-10・C-030): 回答本文の保存を足したとき、
#      テストの模擬実行が**実物の `logs/eval-details/` に書いていた**。
#      回帰 1 回につき 9 個のディレクトリが増え、気づいたときには 70 個近くたまっていた。
#      テストは自分の作ったものだけを触る——**後片付けの範囲ではなく、そもそも実物に触らない**。
run_eval() {
  set +e
  OUT="$(
    EVAL_SWEEP_RECALL_REPO_DIR="$DUMMY_REPO" \
    EVAL_SWEEP_RECALL_FIXTURES_DIR="$FIXTURES_DIR" \
    EVAL_SWEEP_RECALL_LOCK_DIR="$WORKDIR/lock" \
    AIDD_LOG_DIR="$WORKDIR/logs" \
    EVAL_SWEEP_RECALL_AGENT_CMD="MOCK_RESPONSE_FILE='$MOCK_RESPONSE_FILE' '$MOCK_AGENT'" \
    bash "$SCRIPT" sweep-x 2>&1
  )"
  EXIT_CODE=$?
  set -e
}

echo "=== scenario 1: JSON 応答の detail に期待パスとキーワード → HIT ==="
printf '{"status":"pass","detail":"src/lib/probe/repository.ts:5 — internalNote が型定義に無い"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "JSON 応答で HIT"
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "exit $EXIT_CODE"

echo "=== scenario 2: 素のテキスト応答（--json-schema 無視）でも本文に期待パスとキーワードがあれば HIT（issue #731） ==="
# WHY: 2026-09-05 実測。haiku が Markdown の素テキストで返し、jq が失敗して detail 空 → MISS になっていた
printf '## 調査結果\n\n3. **EvalFixtureRecallItem** - src/lib/probe/repository.ts\n   - mapper が internalNote を追加返却\n' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "素テキスト応答で HIT（生出力 fallback）"
assert_contains "$OUT" "JSON ではないため生出力全体を判定対象" "fallback したことを標準エラーに出す"

echo "=== scenario 3: 素のテキスト応答で期待パスが無ければ MISS（fallback が過検出を生まない） ==="
printf '## 調査結果\n\n指摘なし。internalNote について特記事項なし\n' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 0 / 1" "パス無しは MISS のまま"
[ "$EXIT_CODE" -eq 1 ] && ok "MISS で exit 1" || ng "MISS なのに exit $EXIT_CODE"

echo "=== scenario 4: expectedFilePathContains が配列なら、いずれか 1 つのパスで HIT（層をまたぐ欠陥、issue #731） ==="
# WHY: 型定義と mapper の不一致のように 2 ファイルにまたがる欠陥は、エージェントがどちら側を指しても正しい検出
echo '{ "expectedFilePathContains": ["probe/repository.ts", "types/probe.ts"], "expectedKeywords": ["internalNote"] }' > "$FIXTURES_DIR/sweep-x/case-1/expected.json"
printf '{"status":"pass","detail":"src/types/probe.ts — internalNote が型定義に無い（repository が返している）"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 1 / 1" "配列の 2 つ目のパスで HIT"
printf '{"status":"pass","detail":"src/lib/other.ts — internalNote について"}' > "$MOCK_RESPONSE_FILE"
run_eval
assert_contains "$OUT" "recall: 0 / 1" "配列のどれにも一致しなければ MISS"

echo "=== scenario 5: 実行痕跡が REPO_DIR の docs/agents/eval-runs.jsonl に追記される ==="
RUNS="$(cat "$DUMMY_REPO/docs/agents/eval-runs.jsonl")"
assert_contains "$RUNS" '"fixtureSet": "sweep-x"' "fixtureSet を記録"
# 条件（設計提案 3）: **同じ条件の回どうしでしかばらつきは比べられない**ので、
# 何を測った木か・どのモデルかを一緒に残す。所要時間も（費用は取れる経路がまだ無い）
assert_contains "$RUNS" '"workflowsTree"' "プロンプトの木を記録（条件）"
assert_contains "$RUNS" '"fixturesTree"' "fixture の木を記録（条件）"
assert_contains "$RUNS" '"model": "haiku"' "どのモデルで測ったかを記録（条件）"
assert_contains "$RUNS" '"elapsedSeconds"' "所要時間を記録"
# 条件の欄が壊れると比較が永久に一致しなくなる。改行を含む値が入っていないこと
if printf '%s' "$RUNS" | grep -q 'HEAD:'; then
  echo "  NG: 条件の欄に git rev-parse の未解決な引数が入っている"; fail=1
else
  echo "  OK: 条件の欄が壊れていない（未解決の引数が混ざらない）"
fi
LINES="$(wc -l < "$DUMMY_REPO/docs/agents/eval-runs.jsonl" | tr -d ' ')"
[ "$LINES" -eq 5 ] && ok "5 回の実行で 5 行" || ng "行数が ${LINES}（期待 5）"

echo "=== scenario 6: 期待パスとキーワードが別々の指摘に分かれていたら MISS（R11 の後段） ==="
# WHY(2026-09-10): Sweep はリポジトリ全体を掃くので、この fixture と無関係な指摘が並ぶのが普通。
#      本文全体で「パスがある AND キーワードがある」を見ていたため、
#      **2 つの別々の指摘にまたがっていても HIT** になっていた（＝欠陥を外していても満点）。
cat > "$MOCK_RESPONSE_FILE" <<'RESP'
{"status":"pass","detail":"FINDINGS: 2\n1. src/lib/probe/repository.ts のレスポンス型が統一されていません\n2. src/lib/other/service.ts に internalNote の型不一致があります"}
RESP
run_eval
assert_contains "$OUT" "MISS" "分散した指摘は MISS"
assert_contains "$OUT" "従来の判定" "従来の判定との差をその場で出す"
assert_contains "$OUT" "1 / 1" "従来の判定なら HIT だったことを数字で出す"
[ "$EXIT_CODE" -ne 0 ] && ok "MISS なので exit 0 でない" || ng "分散した指摘で exit 0 になった"

RUNS6="$(tail -n 1 "$DUMMY_REPO/docs/agents/eval-runs.jsonl")"
assert_contains "$RUNS6" '"pass": 0' "新しい判定での結果を記録"
assert_contains "$RUNS6" '"loosePass": 1' "従来の判定での結果も記録（切り替えの影響を後から測れる）"
assert_contains "$RUNS6" '"detailsDir"' "回答本文の置き場を記録（採点器を直したとき測り直せる）"

echo "=== scenario 7: 同じ指摘の中でそろっていれば HIT（対照。厳しくしすぎていない） ==="
cat > "$MOCK_RESPONSE_FILE" <<'RESP'
{"status":"pass","detail":"FINDINGS: 2\n1. src/lib/other/service.ts のログが冗長です\n2. src/lib/probe/repository.ts に internalNote の型不一致があります"}
RESP
run_eval
assert_contains "$OUT" "recall: 1 / 1" "同じ指摘の中でそろっていれば HIT"
[ "$EXIT_CODE" -eq 0 ] && ok "exit 0" || ng "HIT なのに exit 0 でない" "$OUT"
if printf '%s' "$OUT" | grep -q "従来の判定"; then
  ng "差が無いのに従来の判定を出した"
else
  ok "差が無いときは余計な行を出さない"
fi

echo "=== scenario 8b: プロンプトが未コミットなら、走らせる前に警告する ==="
# WHY(2026-09-10・R11 の後段): eval は **clone(HEAD)** からプロンプトを読むので、
#      手元で直しただけの版は測られない。記録には workflowsDirty として残っていたが、
#      **走らせている本人には何も出ていなかった**（「直したのに数字が変わらない」の原因になる）。
# まず綺麗な木で出ないことを確かめる（対照。常に出す実装でも緑にならないように）
if printf '%s' "$OUT" | grep -q "未コミットの変更があります"; then
  ng "綺麗な木なのに警告が出た" "$OUT"
else
  ok "未コミットが無ければ黙っている（対照）"
fi
echo "// uncommitted change" >> "$DUMMY_REPO/.claude/workflows/lib/prompts/sweep.js"
run_eval
assert_contains "$OUT" ".claude/workflows に未コミットの変更があります" "未コミットのプロンプトを名指しする"
assert_contains "$OUT" "測られません" "その変更は評価に入らないと言う"
(cd "$DUMMY_REPO" && git checkout -- .claude/workflows/lib/prompts/sweep.js)
run_eval
if printf '%s' "$OUT" | grep -q "未コミットの変更があります"; then
  ng "戻したのに警告が残る" "$OUT"
else
  ok "コミット済みに戻せば黙る"
fi

echo "=== scenario 8c: テストの模擬実行が実物の logs/ を汚さない（C-030） ==="
# WHY(2026-09-10): 回答本文の保存を足した直後、**このテスト自身が実物の
#      `logs/eval-details/` に書いていた**。回帰 1 回につき 9 個増え、70 個近くたまっていた。
#      「後片付けをする」ではなく「**そもそも実物に触らない**」で直す（AIDD_LOG_DIR）。
# WHY(|| true が要る、2026-09-10): このテストは `set -euo pipefail` で動く。
#      `resolve_log_dir` は git の情報から置き場を決めるので、**git リポジトリでない環境**
#      （check-rule-guard-effective.test.sh が作る複製サンドボックス）では失敗し、
#      代入ごと `set -e` に引っかかってテスト全体が落ちる。
#      手元では git リポジトリなので通り、**サンドボックスでだけ落ちた**（C-042）。
# WHY(数える処理を関数にして必ず 0 で返す、2026-09-10): このテストは `set -euo pipefail` で動く。
#      `find` は存在しないディレクトリで非ゼロを返し、`pipefail` の下ではパイプ全体が失敗になる。
#      最初は素の `$(find ... | wc -l)` と書いたので、**複製サンドボックス**
#      （check-rule-guard-effective.test.sh が作る、logs/ の無い環境）でだけ
#      テスト全体が落ちた。手元では通っていた（C-042: 測る環境が実利用と違う）。
count_sweep_x_dirs() { # $1 = ログ置き場
  find "$1/eval-details" -maxdepth 1 -type d -name '*-sweep-x' 2>/dev/null -exec echo x \; | wc -l | tr -d ' '
  return 0
}
REAL_LOG_DIR="$(AIDD_LOG_DIR= bash -c "source '$SCRIPT_DIR/lib/resolve-log-dir.sh'; resolve_log_dir" 2>/dev/null || true)"
if [ -n "$REAL_LOG_DIR" ]; then
  BEFORE_DIRS="$(count_sweep_x_dirs "$REAL_LOG_DIR")"
  run_eval
  AFTER_DIRS="$(count_sweep_x_dirs "$REAL_LOG_DIR")"
  if [ "$BEFORE_DIRS" = "$AFTER_DIRS" ]; then
    ok "実物の logs/eval-details に何も足さない（${BEFORE_DIRS} のまま）"
  else
    ng "テストが実物の logs/ を汚した（${BEFORE_DIRS} → ${AFTER_DIRS}）" "AIDD_LOG_DIR を一時ディレクトリへ向ける"
  fi
  # 対照: 一時ディレクトリ側には実際に書かれている（無効化しただけではないこと）
  if find "$WORKDIR/logs/eval-details" -maxdepth 1 -type d -name '*-sweep-x' 2>/dev/null | grep -q .; then
    ok "一時ディレクトリ側には残っている（保存そのものは効いている）"
  else
    ng "一時ディレクトリにも残っていない（保存が働いていない）"
  fi
else
  ok "ログの置き場を解決できないので飛ばす（この環境では判定しない）"
fi

echo "=== scenario 8: 判定に使った回答本文が実際に保存されている ==="
DETAILS_LINE="$(printf '%s' "$OUT" | grep -e "回答本文:" | head -1)"
DETAILS_PATH="${DETAILS_LINE#回答本文: }"
if [ -n "$DETAILS_PATH" ] && [ -f "$DETAILS_PATH/case-1.txt" ]; then
  ok "case ごとに本文を残す"
  if grep -q "internalNote" "$DETAILS_PATH/case-1.txt"; then
    ok "判定に使った本文そのものが入っている"
  else
    ng "保存された本文が判定対象と違う" "$(cat "$DETAILS_PATH/case-1.txt")"
  fi
else
  ng "回答本文が保存されていない" "$DETAILS_LINE"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
