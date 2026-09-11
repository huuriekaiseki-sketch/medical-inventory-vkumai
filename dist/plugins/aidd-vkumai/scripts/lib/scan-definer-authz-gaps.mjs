// scripts/lib/scan-definer-authz-gaps.mjs
//
// WHY(2026-09-10、実測から): `SECURITY DEFINER` は RLS を通らないので、
//      関数の中で**呼び出し元が誰か**を確かめないと、client から呼べる時点で境界が無い。
//      既存の `scan-guard-regressions.mjs` は「**前の版にあった判定が消えた**」しか見ない。
//      つまり**最初から判定の無い新しい関数は素通り**する。
//
//      この穴は実測で見つけた。仕込んだ「認可チェックの無い SECURITY DEFINER 関数」を
//      Sweep（LLM・haiku）は **5 回とも見逃した**。sonnet は見つけたが 1 回 $2.50 かかる。
//      **人にも LLM にも「必ず全件見る」を守らせるより、機械で数えるほうが確実で安い。**
//
// 何を見るか: migration をファイル名順（＝適用順）に畳み、最終的に有効な関数について
//      (1) `SECURITY DEFINER` か
//      (2) client のロール（anon / authenticated / public）へ `GRANT EXECUTE` されているか
//      (3) 本文または宣言に**呼び出し元を確かめる判定**が 1 つでもあるか
//      を見て、(1) かつ (2) かつ (3) でないものを違反にする。
//
// 「呼び出し元を確かめる判定」とみなすもの:
//      auth.uid() / auth.jwt() / is_admin() / is_facility_member() / is_facility_writer() /
//      is_viewer() / has_aal2() / assert_facility_owns()
//      **`user_facilities` を引いているだけ**は含めない——「誰かが所属しているか」は
//      「呼び出し元が所属しているか」ではない（2026-09-10 の held-out fixture がこの形）。
//
// 意図して置くとき: migration に `-- definer-open: <理由>` を同じ行に書く。
//      理由が要る（空では通さない）。
//
// 限界:
//   - **静的解析**。実 DB の `pg_proc` / `information_schema.role_routine_grants` ではなく
//     migration のテキストを読む。DB へ直接あてた変更は見えない
//   - **名前で見ているだけ**で、判定が効く位置にあるかは見ない
//     （`IF NOT is_admin() THEN` を `IF true THEN` にすれば素通りする。それは変異検査の仕事）
//   - `GRANT ... ON ALL FUNCTIONS IN SCHEMA` のような一括付与は関数名を持たないので追えない
//   - 引数の違う同名関数（オーバーロード）を区別しない。このリポジトリには無い
//
// 使い方: node scripts/lib/scan-definer-authz-gaps.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFINITION_RE, PARSE_RE, stripComments } from './scan-guard-regressions.mjs'
import { writeLine } from './stdout-sync.mjs'

// WHY(2026-09-12): 配られると、この走査器は**配布物の中**にある。スクリプトの位置から
//      `../..` で組み立てると、導入先ではなく**プラグイン自身**を探して ENOENT で落ちる（E-086）。
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR
  ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 呼び出し元が誰かを確かめる判定。ここに無いものは「確かめていない」とみなす（安全側） */
export const CALLER_GUARDS = [
  { name: 'auth.uid()', re: /\bauth\.uid\s*\(/i },
  { name: 'auth.jwt()', re: /\bauth\.jwt\s*\(/i },
  { name: 'is_admin()', re: /\bis_admin\s*\(/i },
  { name: 'is_facility_member()', re: /\bis_facility_member\s*\(/i },
  { name: 'is_facility_writer()', re: /\bis_facility_writer\s*\(/i },
  { name: 'is_viewer()', re: /\bis_viewer\s*\(/i },
  { name: 'has_aal2()', re: /\bhas_aal2\s*\(/i },
  { name: 'assert_facility_owns()', re: /\bassert_facility_owns\s*\(/i },
]

/** client から到達できるロール */
const CLIENT_ROLES = new Set(['anon', 'authenticated', 'public'])

const GRANT_RE =
  /\b(grant|revoke)\s+(?:all\s+privileges\s+on|all\s+on|execute\s+on)\s+function\s+([\s\S]*?)\s+(?:to|from)\s+([a-z_,\s"]+?)(?:;|$)/gi

/** GRANT / REVOKE の対象に書かれた関数名を拾う（`f(uuid), g()` のような列挙も追う） */
export function functionNamesIn(target) {
  const withArgs = [...target.matchAll(/(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi)].map((m) => m[1].toLowerCase())
  if (withArgs.length > 0) return withArgs
  return [...target.matchAll(/(?:public\.)?([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase())
}

export function scan(migrationsDir = path.join(REPO_ROOT, 'supabase/migrations')) {
  /** 関数名 → 最後に定義した版 */
  const latest = new Map()
  /** 関数名 → いま到達できる client のロール（最後の GRANT / REVOKE が勝つ） */
  const reach = new Map()
  let declared = 0
  let parsed = 0

  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    const raw = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    const sql = stripComments(raw)

    // 逃がす印はコメントに書くので、コメントを外す前の生文字列で見る。
    // 理由は同じ行に要る（改行をまたいで次の行を理由と読まないため）
    const open = /--[ \t]*definer-open:[ \t]*\S/.test(raw)

    declared += [...sql.matchAll(DEFINITION_RE)].length

    for (const m of sql.matchAll(PARSE_RE)) {
      parsed += 1
      const name = m[1].toLowerCase()
      const head = m[3] ?? ''
      const body = m[5] ?? ''
      const text = head + body
      latest.set(name, {
        file,
        definer: /\bsecurity\s+definer\b/i.test(head),
        guards: CALLER_GUARDS.filter((g) => g.re.test(text)).map((g) => g.name),
        open,
      })
    }

    for (const g of sql.matchAll(GRANT_RE)) {
      const kind = g[1].toLowerCase()
      const roles = g[3].split(',').map((r) => r.trim().replace(/"/g, '').toLowerCase())
      for (const n of functionNamesIn(g[2])) {
        const cur = reach.get(n) ?? new Set()
        for (const r of roles) {
          if (!CLIENT_ROLES.has(r)) continue
          if (kind === 'grant') cur.add(r)
          else cur.delete(r)
        }
        reach.set(n, cur)
      }
    }
  }

  const violations = []
  const reachable = []
  for (const [name, info] of latest) {
    if (!info.definer) continue
    const roles = [...(reach.get(name) ?? [])].sort()
    if (roles.length === 0) continue
    reachable.push({ name, roles, guards: info.guards, file: info.file })
    if (info.guards.length > 0) continue
    if (info.open) continue
    violations.push(
      `definer-authz-gap: ${name} — SECURITY DEFINER で ${roles.join(' / ')} から呼べるのに、` +
        `呼び出し元を確かめる判定が 1 つも無い（${info.file}）。` +
        'auth.uid() と突き合わせるか is_facility_member() 等を使う。' +
        '意図して開けるなら migration に「-- definer-open: 理由」を書く'
    )
  }

  return { latest, reach, reachable, violations, declared, parsed }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.DEFINER_AUTHZ_DIR ?? path.join(REPO_ROOT, 'supabase/migrations')
  const { latest, reachable, violations, declared, parsed } = scan(dir)

  // fail-open 防止 1: 関数を 1 つも見つけられないと、違反ゼロで「合格」に見える
  if (latest.size === 0) {
    console.error('scan-definer-authz-gaps: 関数を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: 宣言の数と解析できた数が食い違う＝**黙って読み飛ばしている**
  if (declared !== parsed) {
    console.error(
      `scan-definer-authz-gaps: 関数の定義 ${declared} 件のうち ${parsed} 件しか解析できていない` +
        '（$$ 以外のドル引用符など、走査の想定外の書き方がある）'
    )
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    for (const r of [...reachable].sort((a, b) => a.name.localeCompare(b.name))) {
      writeLine(`  ${r.name} [${r.roles.join(',')}]: ${r.guards.join(', ') || '**判定なし**'}（${r.file}）`)
    }
  }
  for (const v of violations) writeLine(v)
  writeLine(
    `functions=${latest.size} definitions=${parsed} client-reachable-definer=${reachable.length} violations=${violations.length}`
  )
  process.exit(violations.length > 0 ? 1 : 0)
}
