#!/usr/bin/env bash
# WHY: 2026-09-07。統合テストが 2 件、**いつからか分からないほど前から赤いまま**放置されていた。
#      検知の仕組みが動いていなかったのではなく、「最後に全件を通したのはいつで、結果は何だったか」
#      を誰も記録していなかったので、誰も気づけなかった。
#      GitHub の CI が止まっている間、統合テストを回すのは人（またはエージェント）だけであり、
#      回したかどうかは自己申告に頼るしかない。せめて**回したときの結果は自己申告にしない**。
#
#      そこで実行そのものをここで包み、終了コードから結果を機械的に記録する。
#      「通ったことにする」ことはできない（記録するのは exit code であって主張ではない）。
#
#      記録は check-integration-freshness.sh（SessionStart hook）が読み、
#      「一度も無い」「前回が赤」「supabase/ が前回の記録から変わっている」のいずれかで警告する。
#
# あわせて、実行前に**追記専用テーブルの積み上がり**を知らせる（2026-09-08 追加）。
#      audit_log / access_denials は消せない（TRUNCATE もトリガーが止める）ので、手元で使うほど
#      積み上がる。PostgREST の既定上限（1,000 行）を越えると「全件を取って差分を数える」形の
#      テストが**古い順に切り落とされ、監査の取りこぼしに見える失敗**をする（E-023。実測 1,195 行で
#      発火した）。同じ型が E-022 にもある。掃除の正式手段は `supabase db reset`（追記専用なので
#      他に消す手段は無い）。**止めずに知らせるだけ**にする（回したいときに回せない方が困る）。
#      閾値は aidd.config.json の limits.localLogRowsWarnAt（2026-09-08 に確認して 800）。
#
# 使い方: bash scripts/run-integration-tests.sh [追加の vitest 引数...]
#   実 DB が要る（supabase start 済み）。記録は logs/integration-runs.jsonl。
#   積み上がりの警告だけを見たいときは --check-pileup-only。
#
# 環境変数（テスト用注入ポイント）:
#   RIT_PILEUP_THRESHOLD   知らせる行数（既定 aidd.config.json の limits.localLogRowsWarnAt）
#   RIT_ENV_FILE           接続情報を読むファイル（既定 .env.test。空文字なら読まず process env を使う）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"

cd "$REPO_ROOT" || exit 1

LOG_DIR="$(resolve_log_dir)"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/integration-runs.jsonl"

# 追記専用テーブルの積み上がりを知らせる。数えられない（DB が起動していない・env が無い）場合は黙る。
# WHY(黙る): ここは本題ではない。数えられないことを理由に統合テストの実行を邪魔しない。
warn_if_logs_piled_up() {
  local threshold
  threshold="${RIT_PILEUP_THRESHOLD:-$(jq -r '.limits.localLogRowsWarnAt // empty' "$REPO_ROOT/aidd.config.json" 2>/dev/null)}"
  [ -n "$threshold" ] || return 0

  # WHY(空文字を許す): テストは自前の接続情報を process env で渡す。--env-file は
  #      既に設定済みの変数を上書きしないが、その挙動に頼らず「読まない」を選べるようにする。
  local env_file="${RIT_ENV_FILE-$REPO_ROOT/.env.test}"
  local env_flag=""
  # WHY(配列を使わない): bash 3.2（macOS 標準）は空配列の "${a[@]}" を set -u で unbound にする。
  #      引数は 1 個だけなので、空文字を渡さない形で分岐する。
  [ -n "$env_file" ] && [ -f "$env_file" ] && env_flag="--env-file=$env_file"

  # WHY(--input-type=module): stdin から読む場合、import 構文でも既定で ESM 扱いにならない版がある。
  # WHY(2>/dev/null): node 自体のエラー（DB 停止時の警告等）は本題ではないので黙らせる。
  #      **警告は stdout に出す**（stderr に出すとここで一緒に消える）。
  node ${env_flag:+"$env_flag"} --input-type=module - "$threshold" "$REPO_ROOT" <<'NODE' 2>/dev/null || true
import fs from 'node:fs'
import path from 'node:path'

const threshold = Number(process.argv[2])
const root = process.argv[3]
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) process.exit(0)

// WHY(ローカル以外は数えない): 本番へ問い合わせに行かない。e2e/env-guard.ts と同じ許可ホスト。
let host
try { host = new URL(url).hostname } catch { process.exit(0) }
if (!['127.0.0.1', 'localhost'].includes(host)) process.exit(0)

// append-only の表 = _immutable() を呼ぶトリガーが付いている表。
// WHY(表の一覧を手で持たない): 表を足したときに一覧の更新を忘れると、この警告だけが静かに
//      片手落ちになる。check-append-only-log-indexes.test.sh と同じ見つけ方をする。
const dir = path.join(root, 'supabase/migrations')
let sql = ''
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
  sql += fs.readFileSync(path.join(dir, f), 'utf8') + '\n'
}
const clean = sql.replace(/--[^\n]*/g, ' ')
const tables = new Set()
for (const m of clean.matchAll(
  /create\s+trigger\s+[a-z0-9_]+[\s\S]{0,200}?\son\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?[\s\S]{0,200}?execute\s+function\s+(?:public\.)?[a-z0-9_]*_immutable\s*\(/gi,
)) tables.add(m[1].toLowerCase())
if (tables.size === 0) process.exit(0)

const over = []
for (const t of [...tables].sort()) {
  let res
  try {
    res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, {
      method: 'HEAD',
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: 'count=exact' },
    })
  } catch { process.exit(0) }   // DB が起動していない
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')
  if (!m) continue
  const n = Number(m[1])
  if (n >= threshold) over.push(`${t}=${n} 行`)
}
if (over.length > 0) {
  console.log(`[run-integration-tests] 手元の追記専用テーブルが積み上がっています（閾値 ${threshold} 行）: ${over.join(', ')}`)
  console.log('[run-integration-tests] PostgREST の既定上限 1,000 行を越えると、全件を取る形のテストが古い順に切り落とされ「監査の取りこぼし」に見える失敗をします（E-022 / E-023）。')
  console.log('[run-integration-tests] 追記専用なので個別には消せません。作り直してください: supabase db reset')
}
NODE
}

warn_if_logs_piled_up

if [ "${1:-}" = "--check-pileup-only" ]; then
  exit 0
fi

# WHY(npx を使わない): scripts/check-no-registry-fetch.test.sh が hook スクリプトの npx を禁止する
#      （2026-09-04 に CI が 4〜8 倍かかった原因）。node_modules のものを直接呼ぶ。
# RIT_VITEST_BIN はテスト用の差し替え口（記録の分岐を実 DB 無しで測るため。既定は変えない）。
"${RIT_VITEST_BIN:-./node_modules/.bin/vitest}" run --config vitest.integration.config.ts "$@"
EXIT_CODE=$?

if [ "$EXIT_CODE" -eq 0 ]; then
  RESULT="pass"
else
  RESULT="fail"
fi

# WHY(部分実行は記録しない、2026-09-08): ファイル名や `-t` を渡した実行で「全件通した」と
#      記録すると、check-integration-freshness.sh（SessionStart hook）が嘘の緑を信じる。
#      1 本だけ通した実行が、放置されていた赤 2 件を隠せてしまう形（このスクリプトを作った
#      きっかけそのもの）。run-e2e-tests.sh と同じ扱いに揃える。
if [ "$#" -ne 0 ]; then
  echo "[run-integration-tests] 引数付きの実行なので記録しません（全件を通したときだけ記録する）"
  exit "$EXIT_CODE"
fi

# supabase/ の木のハッシュを残す。次回、ここが変わっていれば「その記録はもう当てにならない」と分かる
# （コミット ID だと無関係な変更でも古く見え、日付だけだと変更に反応しない）
SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
DIRTY="false"
if ! git diff --quiet -- supabase 2>/dev/null; then DIRTY="true"; fi

python3 - "$LOG_FILE" "$RESULT" "$EXIT_CODE" "$SUPABASE_TREE" "$COMMIT" "$BRANCH" "$DIRTY" <<'PY'
import json, sys
from datetime import datetime, timezone

log_file, result, exit_code, tree, commit, branch, dirty = sys.argv[1:8]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": result,
    "exitCode": int(exit_code),
    "supabaseTree": tree,
    "commit": commit,
    "branch": branch,
    # 未コミットの変更がある状態での実行は「その木で通った」証拠にならない
    "supabaseDirty": dirty == "true",
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[run-integration-tests] {result} を記録しました: {log_file}")
PY

exit "$EXIT_CODE"
