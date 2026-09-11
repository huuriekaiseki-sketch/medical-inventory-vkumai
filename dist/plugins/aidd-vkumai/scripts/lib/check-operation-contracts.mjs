#!/usr/bin/env node
// scripts/lib/check-operation-contracts.mjs
//
// WHY(2026-09-09): 決めごとの単位が「表」だったので、実際に穴が開く単位（**表 × 動詞**）と
//      ずれていた。`GRANT ALL` の 3 文字で 4 動詞が開き、**誰も決めていない権限が 20 件**
//      たまっていた（E-056 / E-057）。操作の契約（`docs/agents/operation-contracts.md`、O-xxx）を
//      正本にして、宣言と実態を**両方向**で突き合わせる。
//
// 何を突き合わせるか:
//   1. DB のクライアント権限 ⟷ 宣言
//      - 権限があるのに行が無い          → undeclared-privilege
//      - 行があるのに権限が無い（許可）  → missing-privilege
//      - 行が「禁止」なのに権限がある    → forbidden-privilege（**RPC 経由の約束が破れている**）
//   2. アプリの直接書き込み ⟷ 宣言
//      - 「禁止」なのに書いている        → forbidden-direct-write
//      - 「許可」なのに書いていない      → stale-direct-write
//   3. 入口の実在
//      - `rpc:<名前>` が migration に無い            → missing-rpc
//      - HTTP の入口の route.ts が無い / メソッド未 export → missing-route
//   4. 入口の route が攻撃表に載っているか            → not-in-attack-matrix
//
// WHY(3 と 4 は弱い): route が実在することと、その中で認可を呼んでいることは別。
//      **ここで見るのは「道があるか」まで**で、道の守りは攻撃表（P-017）と
//      RLS の変異計測が受け持つ。弱いことを承知で入れているのは、
//      **入口を足したのに攻撃表へ載せ忘れる**のが実際に起きるため。
//
// 限界:
//   - 認可の列（「施設 writer + aal2」等）は突き合わせていない。文字列として置いてあるだけ
//   - 静的解析。`.from('表').<動詞>(` の形しか見ない（supabase-js のクエリビルダ前提）
//   - `service_role` の書き込みは対象外（W-xxx の担当）
//
// 使い方: node scripts/lib/check-operation-contracts.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTables } from './scan-rls-grant-gaps.mjs'
import { dbWritableVerbs, scanAppWrites, loadRegistry } from './check-write-path-gaps.mjs'
import { writeLine } from './stdout-sync.mjs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = process.env.CLAUDE_PROJECT_DIR ?? path.resolve(ENGINE_DIR, '../..')

const CATALOG = 'docs/agents/operation-contracts.md'
const ATTACK_MATRIX = 'e2e/api-attack-matrix.ts'
const VERBS = ['insert', 'update', 'delete']
const DIRECT_WRITE = ['許可', '禁止']
const RISKS = ['高', '中', '低']
const STATES = ['実装済み', '計画', '対象外']
/**
 * 認可の語彙。**自由記述にしない**（2026-09-09）。
 *
 * WHY: この列は長らく「文字列が置いてあるだけ」で、実態と突き合わせていなかった。
 *      語彙に閉じると、`supabase/__tests__/integration/operation-authz-sweep.integration.test.ts`
 *      が **1 語から立場ごとの期待値を導出して実 DB で測れる**（宣言 35 行 → 実測 200 件超）。
 *      語を足すときは、その語の期待値を掃き側にも足さないと落ちる。
 */
const AUTHORIZATIONS = ['施設 writer + aal2', '親の施設 writer + aal2', 'admin + aal2', '施設 writer']

/** 契約の 1 行 */
export function parseContracts(text) {
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('| O-')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] は行頭の空文字
    const [, id, table, operation, entrypoints, directWrite, authorization, risk, state] = cells
    rows.push({
      id,
      table,
      operation,
      // 入口はバッククォートで囲って ` / ` で並べる
      entrypoints: [...entrypoints.matchAll(/`([^`]+)`/g)].map((m) => m[1]),
      directWrite,
      authorization,
      risk,
      state,
    })
  }
  return rows
}

/** src/app 配下の route.ts を列挙して、`/api/...` => 公開メソッドの集合 にする */
export function discoverRoutes(root) {
  const appDir = path.join(root, 'src', 'app')
  const found = new Map()
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) {
        walk(p)
        continue
      }
      if (name !== 'route.ts') continue
      const src = fs.readFileSync(p, 'utf8')
      const methods = new Set()
      for (const m of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
        if (new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(src)) methods.add(m)
      }
      found.set('/' + path.relative(appDir, path.dirname(p)), methods)
    }
  }
  walk(appDir)
  return found
}

/** migration に定義されている関数名 */
export function discoverRpcs(migrationsDir) {
  const names = new Set()
  if (!fs.existsSync(migrationsDir)) return names
  for (const file of fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      names.add(m[1].toLowerCase())
    }
  }
  return names
}

/**
 * その入口が**実在して公開されているか**。状態が「計画」でも道が開いていれば実在する。
 * rpc: は migration に定義があるか、HTTP は route.ts がそのメソッドを export しているか。
 */
function isLiveEntrypoint(entry, { routes, rpcs }) {
  if (entry.startsWith('rpc:')) return rpcs.has(entry.slice(4).toLowerCase())
  const [method, routePath] = entry.split(/\s+/)
  return routes.get(routePath)?.has(method) ?? false
}

/** 入口の route が攻撃表に載っているか（rpc: は対象外） */
function checkAttackMatrix(v, r, entry, attackMatrixText) {
  if (entry.startsWith('rpc:')) return
  const routePath = entry.split(/\s+/)[1]
  if (attackMatrixText !== null && !attackMatrixText.includes(`'${routePath}'`)) {
    v.push(`not-in-attack-matrix: ${r.id} ${entry}（${ATTACK_MATRIX} に載っていない）`)
  }
}

export function findViolations({ rows, dbVerbs, writes, dynamicCovered, routes, rpcs, attackMatrixText }) {
  const v = []
  // seen は「契約に行がある表 × 動詞」。重複検査と、逆向き突合（下）の両方で使う。
  const seen = new Set()

  for (const r of rows) {
    const key = `${r.table}.${r.operation.toLowerCase()}`

    // 形（語彙）— エンジン側でも見る。文書の形の検査は check-catalog.mjs が別に行う
    if (!VERBS.includes(r.operation.toLowerCase())) v.push(`bad-operation: ${r.id} ${r.operation}`)
    if (!DIRECT_WRITE.includes(r.directWrite)) v.push(`bad-direct-write: ${r.id} ${r.directWrite}`)
    if (!RISKS.includes(r.risk)) v.push(`bad-risk: ${r.id} ${r.risk}`)
    if (!AUTHORIZATIONS.includes(r.authorization)) {
      v.push(`bad-authorization: ${r.id} ${r.authorization}（語彙は ${AUTHORIZATIONS.join(' / ')}。掃き側に期待値がある語だけを使う）`)
    }
    if (!STATES.includes(r.state)) v.push(`bad-state: ${r.id} ${r.state}`)
    if (seen.has(key)) v.push(`duplicate: ${r.id} ${key}（同じ操作が 2 行ある）`)
    seen.add(key)

    const granted = dbVerbs.get(r.table)?.has(r.operation.toLowerCase()) ?? false
    const writtenDirectly = writes.has(key) || dynamicCovered.has(key)
    const liveEntrypoints = r.entrypoints.filter((entry) => isLiveEntrypoint(entry, { routes, rpcs }))

    // WHY(状態が「実装済み」でなくても実態は見る、2026-09-10): 以前はここで continue しており、
    //      行の状態を「計画」「対象外」に書き換えるだけで、その行に関する検査が**全部**消えた。
    //      状態は宣言でしかなく、DB の権限もアプリの書き込みも入口も、状態を変えても消えない。
    //      **宣言と実態が食い違っていること自体**が違反なので、状態を変えて黙らせられないようにする。
    if (r.state !== '実装済み') {
      if (granted) {
        v.push(`unimplemented-but-granted: ${r.id} ${key} — 状態は「${r.state}」だが、DB はクライアントにこの操作を許している（状態を変えても権限は残る。権限を剥がすか、状態を実装済みにする）`)
      }
      if (writtenDirectly) {
        v.push(`unimplemented-but-written: ${r.id} ${key} — 状態は「${r.state}」だが、アプリがこの表をその向きに直接書いている`)
      }
      for (const entry of liveEntrypoints) {
        v.push(`unimplemented-but-live: ${r.id} ${entry} — 状態は「${r.state}」だが、入口が実在して公開されている`)
        checkAttackMatrix(v, r, entry, attackMatrixText)
      }
      continue
    }

    // 1. DB の権限 ⟷ 宣言
    if (r.directWrite === '許可' && !granted) {
      v.push(`missing-privilege: ${r.id} ${key} — 直接書き込みを許可と宣言しているが、DB にクライアント権限が無い（宣言が古いか、剥がしすぎた）`)
    }
    if (r.directWrite === '禁止' && granted) {
      v.push(`forbidden-privilege: ${r.id} ${key} — 直接書き込みを禁止と宣言しているのに、DB がクライアントに許している（RPC だけという約束が破れている）`)
    }

    // 2. アプリの直接書き込み ⟷ 宣言
    if (r.directWrite === '禁止' && writtenDirectly) {
      v.push(`forbidden-direct-write: ${r.id} ${key} — 禁止と宣言しているのに、アプリが表を直接書いている`)
    }
    if (r.directWrite === '許可' && !writtenDirectly) {
      v.push(`stale-direct-write: ${r.id} ${key} — 許可と宣言しているが、アプリはこの表をその向きに書いていない（道を消したなら宣言も消す）`)
    }

    // 3 と 4. 入口の実在と、攻撃表への登録
    if (r.entrypoints.length === 0) v.push(`no-entrypoint: ${r.id} ${key}（入口が空）`)
    for (const entry of r.entrypoints) {
      if (entry.startsWith('rpc:')) {
        const name = entry.slice(4).toLowerCase()
        if (!rpcs.has(name)) v.push(`missing-rpc: ${r.id} ${entry}（migration に定義が無い）`)
        continue
      }
      const [method, routePath] = entry.split(/\s+/)
      const methods = routes.get(routePath)
      if (!methods) {
        v.push(`missing-route: ${r.id} ${entry}（route.ts が無い）`)
        continue
      }
      if (!methods.has(method)) {
        v.push(`missing-route: ${r.id} ${entry}（route.ts はあるが ${method} を export していない）`)
        continue
      }
      // WHY(攻撃表への登録を必須にする): 入口を足したのに攻撃表へ載せ忘れると、
      //      その入口だけ他施設からの直接攻撃を一度も試さないまま通る
      checkAttackMatrix(v, r, entry, attackMatrixText)
    }
  }

  // 1 の逆向き: DB が許しているのに契約に行が無い。
  // WHY(状態を見ない、2026-09-10): 以前はここで「実装済みの行だけ」を宣言とみなす案も考えたが、
  //      行があるのに状態が「計画」の場合は上の unimplemented-but-granted が既に名指ししており、
  //      ここでも出すと同じことを 2 回言うだけになる。**状態を書き換えて黙らせられない**という
  //      肝心の性質は、continue を廃した上のループ（unimplemented-but-*）が担っている。
  for (const [table, verbs] of [...dbVerbs].sort()) {
    for (const verb of VERBS) {
      if (!verbs.has(verb)) continue
      if (seen.has(`${table}.${verb}`)) continue
      v.push(`undeclared-privilege: ${table}.${verb} — DB がクライアントに許しているが、契約に行が無い（行を足すか、権限を剥がす）`)
    }
  }

  return v
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const verbose = process.argv.includes('--verbose')
  const root = process.env.OPERATION_CONTRACTS_ROOT ?? DEFAULT_ROOT
  const catalogPath = path.join(root, CATALOG)
  if (!fs.existsSync(catalogPath)) {
    console.error(`operation-contracts: ${CATALOG} が無い`)
    process.exit(1)
  }
  const rows = parseContracts(fs.readFileSync(catalogPath, 'utf8'))
  // fail-open 防止: 行を 1 つも読めないと、違反ゼロで「合格」に見える
  if (rows.length === 0) {
    console.error('operation-contracts: 契約の行を 1 つも読めなかった（表の形が変わっている）')
    process.exit(1)
  }

  const registry = loadRegistry(root) ?? { scan: {} }
  const tables = scanTables(path.join(root, registry.migrationsDir ?? 'supabase/migrations'))
  const dbVerbs = dbWritableVerbs(tables)
  const { writes } = scanAppWrites(root, registry.scan ?? {})
  const dynamicCovered = new Set()
  for (const [file, site] of Object.entries(registry.dynamicCallSites ?? {})) {
    if (file.startsWith('_')) continue
    for (const t of site.tables ?? []) for (const verb of site.verbs ?? []) dynamicCovered.add(`${t}.${verb}`)
  }
  const routes = discoverRoutes(root)
  const rpcs = discoverRpcs(path.join(root, registry.migrationsDir ?? 'supabase/migrations'))
  const attackPath = path.join(root, ATTACK_MATRIX)
  const attackMatrixText = fs.existsSync(attackPath) ? fs.readFileSync(attackPath, 'utf8') : null

  if (routes.size === 0) {
    console.error('operation-contracts: route を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }

  const violations = findViolations({ rows, dbVerbs, writes, dynamicCovered, routes, rpcs, attackMatrixText })

  if (verbose) {
    for (const r of rows) {
      writeLine(`  ${r.id} ${r.table}.${r.operation} 直接=${r.directWrite} 入口=${r.entrypoints.join(' / ')}`)
    }
  }
  for (const x of violations) writeLine(x)
  const forbidden = rows.filter((r) => r.directWrite === '禁止').length
  // WHY(何を測っていないかも出す、2026-09-09): 「violations=0」は**この検査が見た範囲で 0**
  //      という意味でしかない。見ていない軸（認可の本文・route の中身）を毎回一緒に出して、
  //      「安全が 0 件保証された」と読まれないようにする
  writeLine(`operations=${rows.length} 直接書き込み禁止=${forbidden} violations=${violations.length}`)
  writeLine(
    '  測っていないもの: 認可の列とポリシー本文の一致（掃き operation-authz-sweep が実 DB で測る）/ ' +
      'route の中で認可を呼んでいるか（攻撃表 P-017）/ その判定が正しいか（RLS の変異計測）',
  )
  process.exit(violations.length > 0 ? 1 : 0)
}
