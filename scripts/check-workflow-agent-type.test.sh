#!/usr/bin/env bash
# WHY(2026-09-18、issue #791): `agent()` に agentType を渡さないと「既定のワークフロー用サブエージェント」＝
#      **全ツール持ち**で起動する。`.claude/agents/*.md` の `tools:` は適用されず、PreToolUse の
#      読み取り専用ガード（check-readonly-bash.sh）も **agent_type が空なので exit 0** で素通りする。
#      **ガードを 2 つ書いてあるのに、どちらも一度も発火していなかった**（E-094）。
#
#      実際に停止①（仕様レビュー）より前の Judge Panel 採点役が、製品コード 4 ファイルを編集して
#      `git commit` まで実行した。採点役に書き込み手段があること自体が誤りだった。
#
#   (a) 停止①より前のワークフロー（aidd-1-1-deep-task.js）の agent() が全て agentType を持つ
#   (b) その agentType に対応する定義が `.claude/agents/` に実在する
#   (c) その agentType が aidd.config.json の readonlyAgentTypes に載っている
#       （**載っていなければガードは「対象ロールではない」と判断して何もしない**。片方だけでは効かない）
#   (d) RED 方向: (a)〜(c) の違反をそれぞれ検知する
#   (e) コメント・文字列リテラルの中の `agent()` を呼び出しと数えない（C-011 の 4 度目）
#   (f) 走査できない・1 件も拾えないことを緑にしない（C-025 / C-044）
#
# 対象を 1 ファイルに絞る理由: 「どの呼び出しが読み取り専用であるべきか」を宣言で持つと、
#      その宣言が腐る（C-010 / C-011）。**停止①より前のワークフローは全部読み取り専用**という
#      性質そのものを使えば宣言が要らない。実装フェーズ（aidd-phase2.js）は書き込む役割が
#      正当に居るので対象外——そちらは別 issue。
#
# 限界:
#   - 対象は下記の 1 ファイルだけ。新しく「停止①より前のワークフロー」を作ってもここには載らない
#   - 静的な走査なので、agentType を変数で渡す形（`agentType: role`）は読めない
#   - 正規表現リテラルの中に引用符があると、そこから先の判定が崩れる（走査器の限界）
#
# 実行: bash scripts/check-workflow-agent-type.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
SCANNER="$SCRIPT_DIR/lib/scan-workflow-agent-type.mjs"
TARGET="$REPO_ROOT/.claude/workflows/aidd-1-1-deep-task.js"
AGENTS="$REPO_ROOT/.claude/agents"
CONFIG="$REPO_ROOT/aidd.config.json"

command -v node >/dev/null 2>&1 || {
  echo "  SKIP: 確認不能（node が無いので走査できません）"
  echo "ALL PASSED"
  exit 0
}

fail=0
assert_ok() { echo "  OK: $1"; }
assert_fail() {
  echo "  NG: $1"
  [ -n "${2:-}" ] && echo "      $2"
  fail=1
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "=== scenario 1: 停止①より前のワークフローの agent() が全て守られている ==="
if [ ! -f "$TARGET" ]; then
  assert_ok "対象なし: この導入先に aidd-1-1-deep-task.js が無い"
else
  # --require-wrapper: 素の agent() は期待件数から漏れるので落とす（issue #797）
  if OUT="$(node "$SCANNER" --file "$TARGET" --agents "$AGENTS" --config "$CONFIG" --require-wrapper 2>&1)"; then
    RC=0
  else
    RC=$?
  fi
  CALLS="$(sed -n 's/.*calls=\([0-9]*\).*/\1/p' <<<"$OUT")"
  if [ "$RC" -eq 0 ]; then
    assert_ok "agent() ${CALLS} 件すべてが trackedAgent() で包まれ、agentType を持ち、定義があり、readonlyAgentTypes に載っている"
  elif [ "$RC" -eq 1 ]; then
    assert_fail "守られていない呼び出しがある" "$(grep '^NG ' <<<"$OUT")
      直し方: agent() の opts に agentType を足す。対応する定義が無ければ .claude/agents/ に作り、
      aidd.config.json の readonlyAgentTypes にも足す（**両方揃わないとガードは効かない**）"
  else
    assert_fail "走査できない（rc=${RC}）" "$OUT"
  fi
fi

echo "=== scenario 2: RED 方向（3 種類の違反をそれぞれ検知する） ==="
mkdir -p "$WORK/agents"
printf -- '---\nname: ok-role\ntools: Read, Bash\n---\n' > "$WORK/agents/ok-role.md"
printf -- '---\nname: writer-role\ntools: Read, Edit, Write, Bash\n---\n' > "$WORK/agents/writer-role.md"
printf '{"readonlyAgentTypes":["ok-role"]}\n' > "$WORK/config.json"

printf "const a = await agent('x', { label: 'good', agentType: 'ok-role' })\n" > "$WORK/good.js"
if node "$SCANNER" --file "$WORK/good.js" --agents "$WORK/agents" --config "$WORK/config.json" > /dev/null 2>&1; then
  assert_ok "正しい fixture は通る（対照）"
else
  assert_fail "正しい fixture で落ちた（誤検知）" "$(node "$SCANNER" --file "$WORK/good.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
fi

printf "const a = await agent('x', { label: 'bare' })\n" > "$WORK/bare.js"
OUT="$(node "$SCANNER" --file "$WORK/bare.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
if grep -q 'agentType が無い' <<<"$OUT"; then
  assert_ok "agentType が無い呼び出しを検知"
else
  assert_fail "agentType 無しを見逃す" "$OUT"
fi

printf "const a = await agent('x', { label: 'ghost', agentType: 'no-such-role' })\n" > "$WORK/ghost.js"
OUT="$(node "$SCANNER" --file "$WORK/ghost.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
if grep -q '対応する定義が無い' <<<"$OUT"; then
  assert_ok "実在しない agentType を検知"
else
  assert_fail "幽霊の agentType を通す" "$OUT"
fi

# ここが肝: agentType はあるが readonlyAgentTypes に無い＝ガードが対象ロールと見なさない
printf "const a = await agent('x', { label: 'writer', agentType: 'writer-role' })\n" > "$WORK/writer.js"
OUT="$(node "$SCANNER" --file "$WORK/writer.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
if grep -q 'readonlyAgentTypes に無い' <<<"$OUT"; then
  assert_ok "readonlyAgentTypes に無い agentType を検知（片方だけでは効かない）"
else
  assert_fail "ガードの対象外なのに通す" "$OUT"
fi

# WHY(issue #797): 期待件数は trackedAgent() が数える。素の agent() で 1 体でも呼ぶと、
#      **その分だけ黙って数から漏れ**、gap check が「期待どおり」と嘘をつく
printf "const a = await agent('x', { label: 'bare-call', agentType: 'ok-role' })\n" > "$WORK/unwrapped.js"
OUT="$(node "$SCANNER" --file "$WORK/unwrapped.js" --agents "$WORK/agents" --config "$WORK/config.json" --require-wrapper 2>&1)"
if grep -q '素の agent() で呼んでいる' <<<"$OUT"; then
  assert_ok "包み忘れ（素の agent()）を検知（issue #797）"
else
  assert_fail "包み忘れを見逃す（期待件数が黙って過小になる）" "$OUT"
fi

printf "const a = await trackedAgent('x', { label: 'wrapped', agentType: 'ok-role' })\n" > "$WORK/wrapped.js"
if node "$SCANNER" --file "$WORK/wrapped.js" --agents "$WORK/agents" --config "$WORK/config.json" --require-wrapper > /dev/null 2>&1; then
  assert_ok "包んだ呼び出しは通る（対照）"
else
  assert_fail "包んだ呼び出しで落ちた（誤検知）" \
    "$(node "$SCANNER" --file "$WORK/wrapped.js" --agents "$WORK/agents" --config "$WORK/config.json" --require-wrapper 2>&1)"
fi

# WHY(C-044 の対): 包んだ呼び出しが走査から**消えない**こと。消えると agentType の検査ごと
#      deep-task を見なくなり、「違反 0 件」が「見ていない」に化ける
printf "const a = await trackedAgent('x', { label: 'ghost-wrapped', agentType: 'no-such-role' })\n" > "$WORK/wrapped-ghost.js"
OUT="$(node "$SCANNER" --file "$WORK/wrapped-ghost.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
if grep -q '対応する定義が無い' <<<"$OUT"; then
  assert_ok "包んだ呼び出しも agentType の検査対象のまま"
else
  assert_fail "包むと走査から消える（検査が空振りになる）" "$OUT"
fi

echo "=== scenario 3: コメント・文字列の中の agent() を数えない（C-011 の 4 度目） ==="
cat > "$WORK/noise.js" <<'JS'
// issue #521: agent()失敗(null)による間引きは件数を明示する
/* agent('これはコメントの中') */
log(`Judge Panel: agent()失敗が${n}件ありました`)
const a = await agent('x', { label: 'real', agentType: 'ok-role' })
JS
OUT="$(node "$SCANNER" --file "$WORK/noise.js" --agents "$WORK/agents" --config "$WORK/config.json" 2>&1)"
RC=$?
CALLS="$(sed -n 's/.*calls=\([0-9]*\).*/\1/p' <<<"$OUT")"
if [ "$RC" -eq 0 ] && [ "${CALLS:-0}" -eq 1 ]; then
  assert_ok "本物の呼び出し 1 件だけを数える（コメント 2 件・文字列 1 件は無視）"
else
  assert_fail "コメントや文字列の中を呼び出しと数えた（calls=${CALLS:-?} rc=${RC}）" "$OUT"
fi

echo "=== scenario 4: 走査できないことを緑にしない（C-025 / C-044） ==="
if node "$SCANNER" --file "$WORK/no-such-file.js" --agents "$WORK/agents" --config "$WORK/config.json" > /dev/null 2>&1; then
  assert_fail "読めないファイルで 0（違反なし）を返した"
else
  RC=$?
  [ "$RC" -eq 2 ] && assert_ok "読めないファイルは 2（無い・ある とは別の答え）" \
    || assert_fail "読めないファイルで ${RC} を返した（2 のはず）"
fi

printf "const x = 1\n" > "$WORK/empty.js"
if node "$SCANNER" --file "$WORK/empty.js" --agents "$WORK/agents" --config "$WORK/config.json" > /dev/null 2>&1; then
  assert_fail "agent() が 1 件も無いのに「違反なし」で通した（走査の空振りを緑にしている）"
else
  RC=$?
  [ "$RC" -eq 2 ] && assert_ok "呼び出しを 1 件も拾えなければ 2（走査が壊れている疑い）" \
    || assert_fail "空振りで ${RC} を返した（2 のはず）"
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL PASSED"
