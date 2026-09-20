// scripts/lib/scan-rls-grant-gaps.mjs
//
// WHY(E-055): RLS は拒否ではなく **0 行**にする。だから「権限（GRANT）はあるのに
//      その操作を通すポリシーが 1 つも無い」組み合わせは、**触れるが何も起きない道**になる。
//      叩いた側にはエラーが返らないので、アプリはそれを別の意味に読む。
//      実際 `facilities` の DELETE がそれで、`DELETE /api/facilities/[id]` は実在する施設に
//      404「施設が見つかりません」を返していた（2026-09-08 実測。認可の問題なのに
//      「見つかりません」と言うので、原因に辿り着く手段が無い）。
//
//      逆向き（ポリシーはあるが GRANT が無い）も同じくらい紛らわしい。
//      こちらは 42501 で落ちるので気づけるが、**書いたポリシーが一度も評価されない**。
//
// 何を見るか: migration をファイル名順（＝適用順）に畳んで、テーブルごとに
//   - RLS が有効か
//   - CREATE / DROP POLICY を追った最終的なポリシー（コマンドと対象ロール）
//   - GRANT / REVOKE を追った最終的な権限
// を組み立て、client ロール（anon / authenticated）について両方向の食い違いを出す。
//
// 限界:
//   - **静的解析**。実際の DB ではなく migration のテキストを読む。
//     Supabase の既定権限（ALTER DEFAULT PRIVILEGES）で後から付く権限は見えない
//     （このリポジトリは「既定に答えを委ねない」を規則にしているので、明示 REVOKE がある表は追える）
//   - `service_role` は対象外。RLS を通らない鍵なので、ポリシーの有無と権限の有無は独立している
//   - ポリシーの中身（USING / WITH CHECK の式）は見ない。「1 つでもあるか」だけ
//   - `FOR ALL` は 4 コマンドすべてを覆うものとして扱う。`TO` を書かないポリシーは PUBLIC 扱い
//
// 使い方: node scripts/lib/scan-rls-grant-gaps.mjs [--verbose]
//   違反があれば行を出して exit 1。無ければ件数だけ出して exit 0。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'

// WHY(2026-09-12): 配られると、この走査器は**配布物の中**にある。スクリプトの位置から
//      `../..` で組み立てると、導入先ではなく**プラグイン自身**の supabase/migrations を探して
//      ENOENT で落ちる（E-086。実測: 導入先を模したリポジトリで 2 本がこれで落ちた）。
//      導入先のルートが分かるときはそれを使う。
const REPO_ROOT = process.env.CLAUDE_PROJECT_DIR
  ? path.resolve(process.env.CLAUDE_PROJECT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const CMDS = ['select', 'insert', 'update', 'delete']
/** RLS が効くロールだけを見る。service_role は RLS を通らない */
const CLIENT_ROLES = ['anon', 'authenticated']

const stripComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
const normalizeTable = (raw) => raw.replace(/"/g, '').replace(/^public\./, '').toLowerCase()

function expandPrivileges(raw) {
  const list = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean)
  if (list.some((p) => p === 'all' || p.startsWith('all '))) {
    return [...CMDS, 'references', 'trigger']
  }
  return list
}

/** migration を適用順に畳んで、テーブルごとの最終的な姿を組み立てる */
export function scanTables(migrationsDir = path.join(REPO_ROOT, 'supabase/migrations')) {
  const tables = new Map()
  const ensure = (name) => {
    if (!tables.has(name)) tables.set(name, { rls: false, policies: new Map(), grants: new Map() })
    return tables.get(name)
  }

  // WHY(2026-09-12): 導入先が supabase/migrations を持たないと readdirSync が ENOENT で
  //      **スクリプトごと異常終了**していた（空のリポジトリで実測）。持っていないだけで
  //      赤くなるのは違う。0 件として進め、「表が 1 つも無い」の判定は呼ぶ側に任せる。
  const files = fs.existsSync(migrationsDir) ? fs.readdirSync(migrationsDir) : []
  for (const file of files.filter((f) => f.endsWith('.sql')).sort()) {
    const sql = stripComments(fs.readFileSync(path.join(migrationsDir, file), 'utf8'))
    const events = []
    const push = (m, e) => events.push({ at: m.index, ...e })

    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/gi))
      push(m, { kind: 'droptable', table: normalizeTable(m[1]) })
    for (const m of sql.matchAll(
      /alter\s+table\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)\s+enable\s+row\s+level\s+security/gi,
    ))
      push(m, { kind: 'rls', table: normalizeTable(m[1]) })
    for (const m of sql.matchAll(
      /create\s+policy\s+("?[^"\s]+"?)\s+on\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)([\s\S]*?)(?:using|with\s+check|;)/gi,
    )) {
      const head = m[3] ?? ''
      const cmd = (/\sfor\s+(all|select|insert|update|delete)\b/i.exec(head) ?? [, 'all'])[1].toLowerCase()
      const to = /\sto\s+([a-z_,\s]+)/i.exec(head)
      const roles = to
        ? to[1].split(',').map((r) => r.trim().toLowerCase()).filter(Boolean)
        : ['public']
      push(m, { kind: 'policy', table: normalizeTable(m[2]), name: m[1].replace(/"/g, ''), cmd, roles })
    }
    for (const m of sql.matchAll(
      /drop\s+policy\s+(?:if\s+exists\s+)?("?[^"\s]+"?)\s+on\s+((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)/gi,
    ))
      push(m, { kind: 'droppolicy', table: normalizeTable(m[2]), name: m[1].replace(/"/g, '') })
    for (const m of sql.matchAll(
      /grant\s+([a-z, ]+?)\s+on\s+(?:table\s+)?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)\s+to\s+([a-z_,\s]+)/gi,
    ))
      push(m, {
        kind: 'grant',
        table: normalizeTable(m[2]),
        privs: expandPrivileges(m[1]),
        roles: m[3].split(',').map((r) => r.trim().toLowerCase()),
      })
    for (const m of sql.matchAll(
      /revoke\s+([a-z, ]+?)\s+on\s+(?:table\s+)?((?:"?public"?\.)?"?[a-z_][a-z0-9_]*"?)\s+from\s+([a-z_,\s]+)/gi,
    ))
      push(m, {
        kind: 'revoke',
        table: normalizeTable(m[2]),
        privs: expandPrivileges(m[1]),
        roles: m[3].split(',').map((r) => r.trim().toLowerCase()),
      })

    // WHY(出現順): 同じ migration が「外して付け直す」ことがある（DROP POLICY → CREATE POLICY）。
    //      種類ごとにまとめて処理すると、後から来た DROP が勝って「付け直したのに無い」と読む。
    for (const e of events.sort((a, b) => a.at - b.at)) {
      if (e.kind === 'droptable') {
        tables.delete(e.table)
        continue
      }
      const t = ensure(e.table)
      if (e.kind === 'rls') t.rls = true
      if (e.kind === 'policy') t.policies.set(e.name, { cmd: e.cmd, roles: e.roles })
      if (e.kind === 'droppolicy') t.policies.delete(e.name)
      if (e.kind === 'grant') {
        for (const role of e.roles) {
          if (!t.grants.has(role)) t.grants.set(role, new Set())
          for (const p of e.privs) t.grants.get(role).add(p)
        }
      }
      if (e.kind === 'revoke') {
        for (const role of e.roles) {
          const held = t.grants.get(role)
          if (held) for (const p of e.privs) held.delete(p)
        }
      }
    }
  }
  return tables
}

function policyCovers(table, cmd, role) {
  return [...table.policies.values()].some(
    (p) => (p.cmd === 'all' || p.cmd === cmd) && (p.roles.includes(role) || p.roles.includes('public')),
  )
}

export function findGaps(tables) {
  const violations = []
  for (const [name, t] of [...tables].sort()) {
    if (!t.rls) continue
    for (const role of CLIENT_ROLES) {
      for (const cmd of CMDS) {
        const granted = t.grants.get(role)?.has(cmd) ?? false
        const covered = policyCovers(t, cmd, role)
        if (granted && !covered) {
          violations.push(
            `silent-noop: ${name} ${cmd.toUpperCase()} — ${role} は権限を持つがポリシーが無い（叩いても 0 行。エラーにならない）`,
          )
        }
        if (!granted && covered) {
          violations.push(
            `unreachable-policy: ${name} ${cmd.toUpperCase()} — ${role} 向けのポリシーがあるが権限が無い（ポリシーが一度も評価されない）`,
          )
        }
      }
    }
  }
  return violations
}

// WHY(issue #806): 素の比較（import.meta.url と、argv[1] の前に file:// を付けた文字列）だと、symlink を含むパスで
//      起動したとき（例: macOS の一時ディレクトリ）に一致せず、main() が走らないまま無出力・exit 0 で終わる。
//      import.meta.url は実体パス、argv[1] は symlink のままだからである。検査にとって無出力・exit 0 は
//      「問題なし」と見分けがつかないので、実体パスへ直してから比べる。
//      この書き方へ戻すと、直接起動の判定を走査する検査（issue #806）が落とす
function isRunAsCli() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}
if (isRunAsCli()) {
  const verbose = process.argv.includes('--verbose')
  const dir = process.env.RLS_GRANT_GAPS_DIR ?? path.join(REPO_ROOT, 'supabase/migrations')
  const tables = scanTables(dir)

  // fail-open 防止: 表を 1 つも見つけられないと、違反ゼロで「合格」に見える
  if (tables.size === 0) {
    console.error('scan-rls-grant-gaps: 表を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }

  const violations = findGaps(tables)
  if (verbose) {
    for (const [name, t] of [...tables].sort()) {
      if (!t.rls) continue
      const g = [...(t.grants.get('authenticated') ?? [])].filter((p) => CMDS.includes(p)).sort()
      writeLine(`  ${name}: authenticated=${g.join(',') || 'なし'} ポリシー=${t.policies.size}`)
    }
  }
  for (const v of violations) writeLine(v)
  writeLine(`checked=${tables.size} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
