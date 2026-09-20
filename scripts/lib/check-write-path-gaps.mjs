#!/usr/bin/env node
// scripts/lib/check-write-path-gaps.mjs
//
// WHY(E-056 / E-057): 層の食い違いには**向きが 2 つ**ある。
//
//   (a) アプリに道があるのに DB が誰にも許さない  → `scan-rls-grant-gaps.mjs` が数えている（E-055）
//   (b) **DB は許すのにアプリに道が無い**          → 2026-09-09 まで**誰も数えていなかった**
//
//      (b) は 2 日で 2 回、別々の表で見つかった。
//      2026-09-08（E-056）は発注・返却で、間違えた発注を製品の中で直せないのに DB は
//      施設の writer に UPDATE / DELETE を許していた。
//      2026-09-09（E-057）は消耗品で、まったく同じ形が**別の表に残っていた**。
//      1 件ずつ直していたので、**同じ型が他の表にも残っていることを誰も数えていなかった**。
//
//      (b) の実害は 2 つある。
//        1. 利用者は間違いを直せない（打ち間違えた名前が発注のたびに選ばれ続ける）
//        2. **使っていない権限が残る**。セッションを奪われたとき、製品に道が無いだけで
//           DB は書き換え・削除を通す。到達範囲（blast radius）が製品の見た目より広い
//
// 何を見るか:
//   - DB 側: migration を畳んで「`authenticated` が本当にできる操作」を出す
//     （GRANT があり、かつその操作を通すポリシーが 1 つ以上ある組み合わせ）。
//     `scan-rls-grant-gaps.mjs` の `scanTables` をそのまま使う（同じ解釈を 2 か所に置かない）。
//   - アプリ側: ソースを走査して `.from('表').insert/update/delete/upsert(` を集める。
//
//   両者を突き合わせ、**DB でできるのにアプリが一度も書かない**組み合わせを出す。
//   それぞれ登録簿に理由を書かせ、**件数を増やせない**（ratchet）。
//
// WHY(RPC 経由の作成を「アプリの道」に数えない): 発注の作成は `create_*_atomic` という
//      SECURITY DEFINER の関数が行う。定義者の権限で動くので、**クライアントの INSERT 権限は
//      使われていない**。つまりその GRANT は余剰で、剥がしても製品は動く。
//      ここで RPC を道に数えてしまうと、その余剰が見えなくなる（この検査の目的そのものが消える）。
//
// WHY(解析できない書き方を「無い」と読まない・C-040): `.from(table)` のように表名が変数の
//      呼び出しがある（`src/lib/orders/cancel.ts`）。走査で拾えないものを黙って
//      「アプリは書いていない」と読むと、**検査のほうが間違っているのに違反が増える**。
//      拾えなかった呼び出しは登録簿で 1 件ずつ宣言させ、**宣言と実測の数が合わなければ落とす**。
//
// 限界:
//   - **静的解析**。`.from('x').insert(` の形しか見ない。supabase-js のクエリビルダを前提にしている
//   - 表を書く道が「あるか」だけを見る。**その道の認可が正しいかは見ない**（それは攻撃表 P-017 の担当）
//   - 逆向き（アプリに道があるのに DB が許さない）は見ない（`scan-rls-grant-gaps.mjs` の担当）
//   - 宣言した理由の中身は読まない。長さだけを見る（「あとで」で済ませないための下限）
//
// 使い方: node scripts/lib/check-write-path-gaps.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { scanTables } from './scan-rls-grant-gaps.mjs'
import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = process.env.CLAUDE_PROJECT_DIR ?? path.resolve(ENGINE_DIR, '../..')

/** 書き込みの動詞。`upsert` は INSERT と UPDATE の両方を要求する */
const VERBS = ['insert', 'update', 'delete']
/** RLS が効くロールだけを見る。service_role は RLS を通らないので製品の道ではない */
const CLIENT_ROLE = 'authenticated'

/**
 * 走査する場所と、宣言（動的な呼び出し・意図した隙間）は導入先ごとに違う。
 * **エンジンは共通・登録簿は導入先**。登録簿が無ければ何も見ない（対象 0 件で通る）。
 */
const REGISTRY = 'scripts/lib/write-path-registry.json'

export function loadRegistry(root = DEFAULT_ROOT) {
  const file = path.join(root, REGISTRY)
  if (!fs.existsSync(file)) return null
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** DB 側: `authenticated` が本当にできる書き込みを {表 => Set(動詞)} で返す */
export function dbWritableVerbs(tables) {
  const out = new Map()
  for (const [name, t] of tables) {
    if (!t.rls) continue
    const granted = t.grants.get(CLIENT_ROLE) ?? new Set()
    const able = new Set()
    for (const verb of VERBS) {
      if (!granted.has(verb)) continue
      const covered = [...t.policies.values()].some(
        (p) => (p.cmd === 'all' || p.cmd === verb) && (p.roles.includes(CLIENT_ROLE) || p.roles.includes('public')),
      )
      if (covered) able.add(verb)
    }
    if (able.size > 0) out.set(name, able)
  }
  return out
}

/**
 * アプリ側: ソースを走査して `.from(...)` の呼び出しを集める。
 * 表名が文字列リテラルなら writes に、そうでなければ dynamic に入れる。
 */
export function scanAppWrites(root, scan) {
  const writes = new Map() // "表.動詞" => Set(ファイル)
  const dynamic = new Map() // ファイル => 件数
  let sites = 0 // 見つけた `.from(` の総数（走査が壊れていないかの目印）
  const exts = scan.extensions ?? ['.ts', '.tsx']
  const excludeDirs = new Set(scan.excludeDirs ?? [])
  const excludeFile = scan.excludeFilePattern ? new RegExp(scan.excludeFilePattern) : null

  const add = (table, verb, file) => {
    const key = `${table}.${verb}`
    if (!writes.has(key)) writes.set(key, new Set())
    writes.get(key).add(file)
  }

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) {
        if (!excludeDirs.has(name)) walk(p)
        continue
      }
      if (!exts.some((e) => name.endsWith(e))) continue
      if (excludeFile?.test(name)) continue
      const rel = path.relative(root, p)
      const src = fs.readFileSync(p, 'utf8')
      // `.from(...)` の直後 200 文字までに書き込みの動詞があれば、その表への書き込みとみなす。
      //
      // WHY(先読みにする): 窓を通常の捕捉にすると matchAll が窓ごと消費し、
      //      **200 文字以内に並んだ次の `.from(` を丸ごと読み飛ばす**。
      //      自作の fixture で 3 件中 2 件を落としていたのを実測して直した（2026-09-09）。
      //      黙って少なく数える走査は、違反ゼロで合格に見える（C-040 と同じ形）
      for (const m of src.matchAll(/\.from\(\s*([^)]*?)\s*\)(?=([\s\S]{0,200}))/g)) {
        const arg = m[1]
        const verbMatch = /\.\s*(insert|update|delete|upsert)\s*\(/.exec(m[2])
        if (!verbMatch) continue
        sites += 1
        const literal = /^['"`]([a-z_][a-z0-9_]*)['"`]$/.exec(arg)
        if (!literal) {
          dynamic.set(rel, (dynamic.get(rel) ?? 0) + 1)
          continue
        }
        const verb = verbMatch[1]
        if (verb === 'upsert') {
          add(literal[1], 'insert', rel)
          add(literal[1], 'update', rel)
        } else {
          add(literal[1], verb, rel)
        }
      }
    }
  }
  for (const r of scan.roots ?? []) walk(path.join(root, r))
  return { writes, dynamic, sites }
}

export function findGaps({ dbVerbs, writes, dynamic, registry }) {
  const violations = []
  const declared = registry.declaredGaps ?? {}
  const dynamicSites = registry.dynamicCallSites ?? {}

  // 1) 解析できなかった呼び出しは 1 件残らず宣言させる（C-040: 「無い」と「読めていない」を分ける）
  const covered = new Map() // 動的な宣言が埋める "表.動詞"
  for (const [file, count] of [...dynamic].sort()) {
    const site = dynamicSites[file]
    if (!site) {
      violations.push(
        `unresolved-from: ${file} に表名が変数の .from(...) が ${count} 件ある（登録簿 dynamicCallSites に宣言する。宣言しないと「アプリは書いていない」と誤って読む）`,
      )
      continue
    }
    if (String(site.reason ?? '').trim().length < 20) {
      violations.push(`no-reason: ${file}（動的な呼び出しが何を書くのかを具体的に書く）`)
    }
    for (const table of site.tables ?? []) {
      for (const verb of site.verbs ?? []) covered.set(`${table}.${verb}`, file)
    }
  }
  // 宣言だけ残った（もう動的な呼び出しが無い）ファイルも落とす
  for (const file of Object.keys(dynamicSites)) {
    if (file.startsWith('_')) continue
    if (!dynamic.has(file)) {
      violations.push(`stale-dynamic: ${file}（表名が変数の .from(...) はもう無い。登録簿から消す）`)
    }
  }

  // 2) DB でできるのにアプリが一度も書かない組み合わせ
  let gapCount = 0
  for (const [table, verbs] of [...dbVerbs].sort()) {
    for (const verb of VERBS) {
      if (!verbs.has(verb)) continue
      const key = `${table}.${verb}`
      if (writes.has(key) || covered.has(key)) continue
      gapCount += 1
      const reason = declared[key]
      if (reason === undefined) {
        violations.push(
          `undeclared-gap: ${key} — DB は authenticated に許しているが、アプリはこの表をその向きに一度も書かない（道を作るか、権限を剥がすか、登録簿 declaredGaps に理由を書く）`,
        )
      } else if (String(reason).trim().length < 20) {
        violations.push(`no-reason: ${key}（なぜ道が無くてよいのかを具体的に書く）`)
      }
    }
  }

  // 3) 宣言だけ残った隙間（道ができた・権限が剥がれた）
  for (const key of Object.keys(declared)) {
    if (key.startsWith('_')) continue
    const [table, verb] = key.split('.')
    const stillOpen = dbVerbs.get(table)?.has(verb) ?? false
    if (!stillOpen) {
      violations.push(`stale-gap: ${key}（DB がもう許していない。登録簿から消す）`)
    } else if (writes.has(key) || covered.has(key)) {
      violations.push(`stale-gap: ${key}（アプリに道ができた。登録簿から消す）`)
    }
  }

  // 4) ratchet: 隙間は増やさない（減らすのは人が決めるので上限だけを見る）
  const max = registry.maxGaps
  if (typeof max !== 'number') {
    violations.push('no-max: 登録簿に maxGaps が無い（増えても気づけない）')
  } else if (gapCount > max) {
    violations.push(
      `over-max: DB は許すのにアプリに道が無い組み合わせが ${gapCount} 件で上限 ${max} を超えた（道を作るか、権限を剥がす）`,
    )
  }

  return { violations, gapCount }
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
  const root = process.env.WRITE_PATH_GAPS_ROOT ?? DEFAULT_ROOT
  const registry = loadRegistry(root)
  if (!registry) {
    writeLine('write-path-gaps: 登録簿が無いので対象 0 件（scripts/lib/write-path-registry.json）')
    process.exit(0)
  }

  const migrationsDir = path.join(root, registry.migrationsDir ?? 'supabase/migrations')
  const tables = scanTables(migrationsDir)
  const dbVerbs = dbWritableVerbs(tables)
  const { writes, dynamic, sites } = scanAppWrites(root, registry.scan ?? {})

  // fail-open 防止: 片側でも空なら走査が壊れている（違反ゼロで「合格」に見える）。
  // アプリ側は**書き込みの呼び出しが 1 つも無い**ことで見る（表名が変数のものも数に入れる）
  if (dbVerbs.size === 0) {
    console.error('write-path-gaps: DB 側で書ける表を 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  if (sites === 0) {
    console.error('write-path-gaps: アプリ側の書き込みを 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }

  const { violations, gapCount } = findGaps({ dbVerbs, writes, dynamic, registry })

  if (verbose) {
    for (const [table, verbs] of [...dbVerbs].sort()) {
      const app = VERBS.filter((v) => writes.has(`${table}.${v}`))
      writeLine(`  ${table}: DB=${[...verbs].sort().join(',')} アプリ=${app.join(',') || 'なし'}`)
    }
  }
  for (const v of violations) writeLine(v)
  writeLine(`tables=${dbVerbs.size} gaps=${gapCount} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
