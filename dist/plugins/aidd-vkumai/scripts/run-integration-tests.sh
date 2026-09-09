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
#      **数えるのは表の総行数ではなく「1 回の問い合わせが返す塊」**（2026-09-08 に変更）。
#      切り落とされるのは問い合わせの結果であって表そのものではない。総行数で数えると、作り直した
#      直後の DB でも E2E と統合を 1 周回すだけで越えて**毎回鳴り、読まれない警告になる**
#      （実測: audit_log は総数 2,467 行に対し最大の塊が 446 行）。
#
# 使い方: bash scripts/run-integration-tests.sh [追加の vitest 引数...]
#   実 DB が要る（supabase start 済み）。記録は logs/integration-runs.jsonl。
#   積み上がりの警告だけを見たいときは --check-pileup-only。
#
# あわせて、**後片付けの漏れ（消し残し）を判定する**（2026-09-10 追加）。
#      統合テストは各ファイルが自分で種をまき自分で消すが、削除の戻り値のエラーを誰も見ておらず、
#      **緑の全件実行 1 回につき業務表に 41 行が積み上がっていた**（165 → 206 → 247 で実測）。
#      原因は 2 つとも黙って失敗していたこと——`price_histories` からの FK（ON DELETE 指定なし）と、
#      その表の GRANT が SELECT のみで先に消す回避もできないこと。
#      数えるのは vitest 側（走り出す前の姿を持っているのはそのプロセスだけ）、
#      判定はここ。**全件を回して緑だったときだけ**判定する——部分実行は他のファイルが作った行を
#      漏れと読み、赤い実行は後片付けが途中で止まるため。
#      報告が**無いときは落とす**（「漏れ 0」ではなく「測れていない」なので。C-021）。
#
# 環境変数（テスト用注入ポイント）:
#   RIT_PILEUP_THRESHOLD   知らせる行数（既定 aidd.config.json の limits.localLogRowsWarnAt）
#   RIT_ENV_FILE           接続情報を読むファイル（既定 .env.test。空文字なら読まず process env を使う）
#   RIT_LEAK_REPORT        消し残しの報告先（既定は毎回新しい一時ファイル）
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=lib/resolve-log-dir.sh
source "$SCRIPT_DIR/lib/resolve-log-dir.sh"
# shellcheck source=lib/worktree-hash.sh
source "$SCRIPT_DIR/lib/worktree-hash.sh"

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

// **表の総行数では数えない**（2026-09-08 に数え方を変えた）。
// WHY: 切り落とされるのは「1 回の問い合わせが返す行」であって表そのものではない。
//      E-023 が実際に当たったのは `audit_log` 全体ではなく `table_name='user_facilities'` の
//      **1,195 行**、E-022 は `access_denials` の guard ごとの塊だった。総行数で数えると、
//      作り直した直後の DB でも E2E と統合を 1 周回すだけで越える（実測: audit_log は
//      0 → 1,311 → 2,467 行。同じときの最大の塊は 446 行）。**毎回鳴る警告は読まれない**ので、
//      塊の単位で数える。塊の値は DB の実データから取る（migrations の解析を二重に持たない）。
// 分類列を持たない表は総行数のまま（新しい表を足したときに黙るより、うるさい方へ倒す）。
const GROUP_BY = { audit_log: 'table_name', access_denials: 'guard', privileged_operations: 'operation' }
const PAGE = 1000
const MAX_PAGES = 50   // 5 万行を越えたら諦めて総行数で報告する（無限ループ防止）

const headers = { apikey: key, Authorization: `Bearer ${key}` }

async function totalRows(t) {
  const res = await fetch(`${url}/rest/v1/${t}?select=*&limit=1`, {
    method: 'HEAD',
    headers: { ...headers, Prefer: 'count=exact' },
  })
  const m = /\/(\d+)$/.exec(res.headers.get('content-range') ?? '')
  return m ? Number(m[1]) : null
}

/** 分類列の値ごとの最大件数。取れなければ null */
async function largestGroup(t, column) {
  const counts = new Map()
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(
      `${url}/rest/v1/${t}?select=${column}&limit=${PAGE}&offset=${page * PAGE}`,
      { headers },
    )
    let rows
    try { rows = await res.json() } catch { return null }
    if (!Array.isArray(rows)) return null
    for (const r of rows) {
      const k = String(r?.[column] ?? '(なし)')
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    if (rows.length < PAGE) {
      let best = null
      for (const [k, n] of counts) if (!best || n > best.n) best = { k, n }
      return best
    }
  }
  return null
}

const over = []
for (const t of [...tables].sort()) {
  try {
    const column = GROUP_BY[t]
    if (column) {
      const best = await largestGroup(t, column)
      if (best) {
        if (best.n >= threshold) over.push(`${t} の ${column}=${best.k} が ${best.n} 行`)
        continue
      }
      // 塊で数えられなかったときは総行数へ落ちる（黙らない）
    }
    const n = await totalRows(t)
    if (n !== null && n >= threshold) over.push(`${t}=${n} 行`)
  } catch { process.exit(0) }   // DB が起動していない
}
if (over.length > 0) {
  console.log(`[run-integration-tests] 手元の追記専用テーブルが積み上がっています（閾値 ${threshold} 行。1 回の問い合わせが返す塊で数えます）: ${over.join(', ')}`)
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
# WHY(消し残しの報告先を渡す、2026-09-10): 走行の前後で「増えて残った行」を数えるのは
#      vitest 側（走り出す前の姿を持っているのはそのプロセスだけ）。合否を決めるのはここ——
#      **全件を回して緑だったときにだけ**意味がある判定で、その 2 つを知っているのはここだけ。
#      RIT_LEAK_REPORT はテスト用の差し替え口（既定は毎回新しい一時ファイル）。
LEAK_REPORT="${RIT_LEAK_REPORT:-$(mktemp)}"
rm -f "$LEAK_REPORT"

# RIT_VITEST_BIN はテスト用の差し替え口（記録の分岐を実 DB 無しで測るため。既定は変えない）。
INTEGRATION_LEAK_REPORT="$LEAK_REPORT" \
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
  echo "[run-integration-tests] 後片付けの漏れも判定しません（他のファイルが作った行を漏れと読むため）"
  exit "$EXIT_CODE"
fi

# --- 後片付けの漏れ（消し残し）を判定する ---------------------------------
# WHY(緑のときだけ、2026-09-10): 赤い実行は afterAll が途中で止まるので、
#      残った行は「漏れ」ではなく「途中で終わった」だけ。赤に赤を重ねても読まれない。
# WHY(ここでは exit しない): 記録（下）は**テストの結果そのもの**で、漏れの判定とは別の事実。
#      ここで抜けると「全件を回した記録が無い」ことになり、鮮度の hook が
#      「一度も回していない」と言い出す（直したはずの事故に化ける）。判定は旗だけ立てて、
#      記録を残してから最後に反映する。
LEAK_FAILED=0
if [ "$EXIT_CODE" -ne 0 ]; then
  echo "[run-integration-tests] 実行が赤なので後片付けの漏れは判定しません（後片付けが途中で止まるため）"
elif [ ! -f "$LEAK_REPORT" ]; then
  # WHY(**無いなら落とす**): 報告が無いのは「漏れが 0」ではなく「測れていない」。
  #      globalSetup の配線が外れていても緑になる形（C-021）を作らない。
  echo "[run-integration-tests] 後片付けの漏れの報告がありません（fixture-guard の配線が外れている疑い）" >&2
  LEAK_FAILED=1
else
  # 上限は台帳から読む（ratchet）。台帳が無ければ 0（fail-closed）
  MAX_LEAKED="$(python3 -c "
import json, sys
try:
    print(json.load(open(sys.argv[1]))['maxLeakedRows'])
except Exception:
    print(0)
" "$REPO_ROOT/scripts/lib/integration-leak-baseline.json" 2>/dev/null || echo 0)"
  LEAKED="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['count'])" "$LEAK_REPORT" 2>/dev/null || echo unknown)"
  if [ "$LEAKED" = "unknown" ]; then
    echo "[run-integration-tests] 後片付けの漏れの報告を読めません: $LEAK_REPORT" >&2
    LEAK_FAILED=1
  elif [ "$LEAKED" -gt "$MAX_LEAKED" ]; then
    echo "[run-integration-tests] **走行中に作った行が $LEAKED 件残りました**（後片付けの漏れ。上限 $MAX_LEAKED）。" >&2
    echo "  各ファイルの afterAll は、自分が作った行を必ず消してください。" >&2
    echo "  削除の戻り値のエラーを捨てないこと（2026-09-10 まで 41 行/回が黙って積み上がっていました）。" >&2
    python3 -c "
import json, sys
rows = json.load(open(sys.argv[1]))['leaked']
for r in rows[:20]:
    print(f'    - {r}', file=sys.stderr)
if len(rows) > 20:
    print(f'    ... 他 {len(rows) - 20} 件', file=sys.stderr)
" "$LEAK_REPORT"
    LEAK_FAILED=1
  fi
fi

# supabase/ の木のハッシュを残す。次回、ここが変わっていれば「その記録はもう当てにならない」と分かる
# （コミット ID だと無関係な変更でも古く見え、日付だけだと変更に反応しない）
SUPABASE_TREE="$(git rev-parse "HEAD:supabase" 2>/dev/null || echo unknown)"
COMMIT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git branch --show-current 2>/dev/null || echo unknown)"
DIRTY="false"
if ! git diff --quiet -- supabase 2>/dev/null; then DIRTY="true"; fi
# WHY(C-041、2026-09-09): HEAD の木だけだと**未コミットの変更**が見えない。
#      「いまの supabase/ の姿」を 1 つのハッシュにして残し、Stop hook が
#      「この状態では全件を通していません」と言えるようにする
SUPABASE_WORKTREE="$(worktree_hash supabase)"

python3 - "$LOG_FILE" "$RESULT" "$EXIT_CODE" "$SUPABASE_TREE" "$COMMIT" "$BRANCH" "$DIRTY" "$SUPABASE_WORKTREE" <<'PY'
import json, sys
from datetime import datetime, timezone

log_file, result, exit_code, tree, commit, branch, dirty, worktree = sys.argv[1:9]
row = {
    "at": datetime.now(timezone.utc).isoformat(),
    "result": result,
    "exitCode": int(exit_code),
    "supabaseTree": tree,
    "commit": commit,
    "branch": branch,
    # 未コミットの変更がある状態での実行は「その木で通った」証拠にならない
    "supabaseDirty": dirty == "true",
    # 未コミットの変更まで含めた「いまの姿」。Stop hook がこれを見る（C-041）
    "supabaseWorktree": worktree,
}
with open(log_file, "a", encoding="utf-8") as f:
    f.write(json.dumps(row, ensure_ascii=False) + "\n")
print(f"[run-integration-tests] {result} を記録しました: {log_file}")
PY

# 漏れがあったら、テストが緑でも実行としては失敗にする（記録はテストの結果のまま残る）
if [ "$LEAK_FAILED" -ne 0 ] && [ "$EXIT_CODE" -eq 0 ]; then
  exit 1
fi
exit "$EXIT_CODE"
