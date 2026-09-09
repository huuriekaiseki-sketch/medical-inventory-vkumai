#!/usr/bin/env bash
# WHY: issue #757 の 7 の続き。**認可の本体は RLS ポリシーにあるのに、そこが測れていなかった。**
#      2026-09-07 に TypeScript 層のテストの効き目を測ったら 62%（補強後 76%）だった。
#      同じ計測を RLS に対して行う。ポリシーを 1 つ壊し、対応するテストが**本当に落ちるか**を実測する。
#      落ちなければ、そのテストは守っていない（緑であることと守っていることは別）。
#
#      受け入れ条件（2026-09-07、Codex の提案を実装可能な形にしたもの）:
#        「認可条件を 1 つ壊したら、対応するテストが少なくとも 1 つ失敗する」
#      アラート発火まで含める案もあったが、外部通知の経路が製品に無いので今回は対象外。
#
# 手順（1 件あたり）:
#   1. 壊す migration を supabase/migrations/ に置く
#   2. supabase db push --local で適用（psql・db execute は hook が禁止しているため migration 経由）
#   3. 対応する統合テストを実行し、**落ちること**を確かめる
#   4. migration を消して supabase db reset で元に戻す
#
#   restore を「元の定義を書き写して戻す」方式にしないのは、その写しがズレの発生源になるため。
#   db reset なら migration ファイルが唯一の正本のまま。
#
# WHY(npx を使わない): scripts/check-no-registry-fetch.test.sh が hook スクリプトの npx を禁止する
#      （2026-09-04 に CI が 4〜8 倍かかった原因）。supabase CLI は PATH のものを、
#      vitest は node_modules のものを直接呼ぶ。どちらもレジストリに触らない。
#
# 実行: bash scripts/check-rls-mutation.sh [MUTANT_ID ...]
#   引数なしで全件。実 DB が要る（supabase start 済み）。全件で 10 分ほどかかる。
#   結果は docs/agents/rls-mutation.md に残す。
#
# WHY(実行を機械で記録する、2026-09-10): この計測は**人が打たないと動かない**。
#      打ったかどうかを自己申告に頼ると、統合テストで起きたのと同じこと
#      （いつからか分からないほど前から赤いまま。E-030）が起こる。
#      せめて**回したときの結果は自己申告にしない**——exit code から
#      logs/rls-mutation-runs.jsonl へ機械的に残し、
#      scripts/check-rls-mutation-freshness.sh（SessionStart hook）が
#      「一度も無い / 前回が赤 / 前回から supabase/ が変わっている」で警告する。
#      **日数ではなく木のハッシュで見る**のは、無関係な変更で鳴る警告は読まれないから。
#      統合テスト・E2E と同じ形（判定は共有の scripts/lib/run-freshness.py）。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CATALOG="$REPO_ROOT/scripts/lib/rls-mutants.json"
MIGRATIONS="$REPO_ROOT/supabase/migrations"
MUTANT_FILE="$MIGRATIONS/99999999999999_rls_mutant.sql"

cd "$REPO_ROOT" || exit 1

cleanup() {
  rm -f "$MUTANT_FILE"
}
trap cleanup EXIT

fail=0
killed=0
survived=0
errors=0
SURVIVORS=""

echo "=== 前提: ポリシー名が migration に実在する（走査が壊れていたら全部生き残る） ==="
MISSING="$(node -e '
const fs = require("fs")
const path = require("path")
const root = process.argv[1]
const dir = path.join(root, "supabase/migrations")
let sql = ""
for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".sql")) sql += fs.readFileSync(path.join(dir, f), "utf8") + "\n"
const cat = JSON.parse(fs.readFileSync(path.join(root, "scripts/lib/rls-mutants.json"), "utf8"))
for (const m of cat.mutants) {
  for (const mm of m.sql.matchAll(/DROP POLICY IF EXISTS "([^"]+)" ON ([a-z_]+)/g)) {
    const re = new RegExp("CREATE POLICY\\s+\"?" + mm[1] + "\"?\\s+ON\\s+" + mm[2] + "\\b")
    if (!re.test(sql)) console.log(m.id + ": " + mm[1] + " on " + mm[2])
  }
  if (!fs.existsSync(path.join(root, m.expect))) console.log(m.id + ": テスト不在 " + m.expect)
}
' "$REPO_ROOT")"
if [ -n "$MISSING" ]; then
  echo "  NG: 一覧が実態とずれている"
  echo "$MISSING"
  echo "FAILED"
  exit 1
fi
echo "  OK: 一覧のポリシーとテストはすべて実在する"

IDS="$(node -e '
const fs = require("fs")
const cat = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const want = process.argv.slice(2)
for (const m of cat.mutants) if (want.length === 0 || want.includes(m.id)) console.log(m.id)
' "$CATALOG" "$@")"

echo ""
echo "=== 起点をきれいにする ==="
supabase db reset --no-seed > /dev/null 2>&1 || { echo "  NG: db reset に失敗（supabase start 済みか確認）"; exit 1; }
echo "  OK: 起点を作った"

for ID in $IDS; do
  BREAKS="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.mutants.find(m=>m.id===process.argv[2]).breaks)' "$CATALOG" "$ID")"
  EXPECT="$(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.mutants.find(m=>m.id===process.argv[2]).expect)' "$CATALOG" "$ID")"
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write("-- rls mutant " + process.argv[2] + "\n" + c.mutants.find(m=>m.id===process.argv[2]).sql + "\n")' "$CATALOG" "$ID" > "$MUTANT_FILE"

  echo ""
  echo "=== $ID: $BREAKS ==="
  if ! supabase db push --local > /dev/null 2>&1; then
    echo "  ERROR: 壊す migration を適用できない（SQL が不正な可能性）"
    errors=$((errors + 1))
    rm -f "$MUTANT_FILE"
    supabase db reset --no-seed > /dev/null 2>&1
    continue
  fi

  if ./node_modules/.bin/vitest run --config vitest.integration.config.ts "$EXPECT" > /dev/null 2>&1; then
    echo "  ★ 生き残った: $EXPECT は壊れた認可に気づかない"
    survived=$((survived + 1))
    SURVIVORS="$SURVIVORS
  $ID $BREAKS
    気づかなかったテスト: $EXPECT"
    fail=1
  else
    echo "  OK: $EXPECT が落ちた（テストが守っている）"
    killed=$((killed + 1))
  fi

  rm -f "$MUTANT_FILE"
  supabase db reset --no-seed > /dev/null 2>&1
done

echo ""
echo "=== 結果 ==="
TOTAL=$((killed + survived))
if [ "$TOTAL" -gt 0 ]; then
  echo "  倒した $killed / $TOTAL（生き残り $survived、実行エラー $errors）"
else
  echo "  対象が 0 件（引数の ID を確認）"
  fail=1
fi

if [ -n "$SURVIVORS" ]; then
  echo ""
  echo "生き残った変異（テストを足す先）:$SURVIVORS"
fi

# --- 実行を記録する -------------------------------------------------------
# WHY(部分実行は記録しない): ID を指定した 1 件だけの実行を「全件通した」と記録すると、
#      鮮度の hook が嘘の緑を信じる。統合テスト・E2E と同じ扱いに揃える。
if [ "$#" -ne 0 ]; then
  echo "[check-rls-mutation] 引数付きの実行なので記録しません（全件を通したときだけ記録する）"
else
  # shellcheck source=lib/resolve-log-dir.sh
  source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
  # shellcheck source=lib/worktree-hash.sh
  source "$SCRIPT_DIR/lib/worktree-hash.sh"
  RLS_LOG_DIR="$(resolve_log_dir)"
  mkdir -p "$RLS_LOG_DIR"
  python3 - "$RLS_LOG_DIR/rls-mutation-runs.jsonl" "$fail" "$killed" "$survived" "$errors" \
    "$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)" \
    "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    "$(git branch --show-current 2>/dev/null || echo unknown)" \
    "$(git diff --quiet -- supabase 2>/dev/null && echo false || echo true)" \
    "$(worktree_hash supabase)" <<'PY'
import json, sys
from datetime import datetime, timezone

log_file, fail, killed, survived, errors, tree, commit, branch, dirty, worktree = sys.argv[1:11]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": "pass" if fail == "0" else "fail",
    "exitCode": int(fail),
    "killed": int(killed),
    "survived": int(survived),
    "errors": int(errors),
    "supabaseTree": tree,
    "commit": commit,
    "branch": branch,
    "supabaseDirty": dirty == "true",
    "supabaseWorktree": worktree,
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[check-rls-mutation] {row['result']} を記録しました: {log_file}")
PY
fi

if [ "$fail" -ne 0 ]; then
  echo "FAILED"
  exit 1
fi
echo "ALL KILLED"
