// scripts/lib/scan-workflow-nesting.mjs
//
// WHY(2026-09-12): Workflow の入れ子は **1 段まで**（Claude Code 2.1.258 で実測）。
//      2 段目を呼んだ瞬間、エージェントを 1 体も起動しないまま
//      「workflow() cannot be called from within a child workflow」で失敗する。
//
//      この上限は中心リポジトリでは踏まない——セッションが router を直接呼び、
//      router が sweep の Workflow を呼ぶので 1 段で収まる。ところが**配布物の形**では、
//      導入先のひな形 wrapper が `<アダプター>:<router>` を呼び、
//      その router がさらに `<アダプター>:<sweep>` を呼ぶので 2 段になる。
//      2026-09-12 の導入先 fixture で実測するまで、**入口が一度も動かないまま気づいていなかった**
//      （受け入れ確認は中身の Workflow を直接呼んでいた。E-085・C-053）。
//
// 何を見るか: `workflow()` の呼び出しを辺として、**辺が 2 本つながる連鎖**（A → B → C）を探す。
//      連鎖が 1 本でもあれば、その入口は実行時に必ず落ちる。
//
// 走査先（--root からの相対）:
//   .claude/workflows/*.js                                 中心リポジトリの Workflow
//   docs/plugin/templates/consumer/.claude/workflows/*.js   導入先ひな形（ここに置くと 2 段になる）
//   dist/plugins/<plugin>/workflows/*.js                    生成物（プラグイン名で修飾される）
//
// 限界（先に書く）:
//   - **静的な読みだけ**。呼び出し名が変数やテンプレートリテラルの合成で決まる形は追えない。
//     実行時の確認は `scripts/workflow-nesting-drill.sh`（本物の Workflow 実行）が担う——対で持つ
//   - `agent()` の入れ子は見ない（上限が違う）
//   - 走査先のディレクトリ名をこのファイルが持つ。置き場を変えたらここも変える
//     （見つけられなければ終了コード 2 で落とすので、黙って緑にはならない）
//
// 使い方:
//   node scripts/lib/scan-workflow-nesting.mjs [--root <dir>] [--json]
// 終了コード: 0 = 連鎖なし / 1 = 連鎖あり / 2 = 走査できない（Workflow を 1 本も見つけられない）

import fs from 'node:fs'
import path from 'node:path'
import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const FIXED_SCAN_DIRS = [
  { dir: '.claude/workflows', world: 'repo', namespace: null },
  { dir: 'docs/plugin/templates/consumer/.claude/workflows', world: 'plugin', namespace: null },
]

/** dist/plugins/<plugin>/workflows も走査先に足す（生成物はプラグイン名で修飾される） */
function pluginScanDirs(root) {
  const base = path.join(root, 'dist/plugins')
  if (!fs.existsSync(base)) return []
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ dir: `dist/plugins/${e.name}/workflows`, world: 'plugin', namespace: e.name }))
}

/** meta.name を取り出す（無ければファイル名） */
export function workflowNameOf(source, file) {
  const m = source.match(/export\s+const\s+meta\s*=\s*\{[\s\S]{0,400}?name:\s*['"`]([^'"`]+)['"`]/)
  if (m) return m[1]
  return path.basename(file, '.js')
}

/** workflow('X') の呼び出し先を全部出す */
export function workflowCallsIn(source) {
  const out = []
  const re = /workflow\(\s*['"`]([^'"`]+)['"`]/g
  let m
  while ((m = re.exec(source)) !== null) out.push(m[1])
  return out
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.js'))
    .map((e) => path.join(dir, e.name))
}

/** 名前を引く表。世界（中心リポジトリ / 配布物）ごとに分ける */
function buildIndex(nodes) {
  const worlds = new Map()
  for (const n of nodes) {
    if (!worlds.has(n.world)) worlds.set(n.world, new Map())
    const byName = worlds.get(n.world)
    byName.set(n.qualified, n)
    if (!byName.has(n.bare)) byName.set(n.bare, n)
  }
  return worlds
}

/** 走査して { nodes, chains } を返す */
export function scanWorkflowNesting(root) {
  const nodes = []
  for (const entry of [...FIXED_SCAN_DIRS, ...pluginScanDirs(root)]) {
    for (const file of listJsFiles(path.join(root, entry.dir))) {
      const source = fs.readFileSync(file, 'utf8')
      const bare = workflowNameOf(source, file)
      nodes.push({
        file: path.relative(root, file),
        world: entry.world,
        bare,
        qualified: entry.namespace ? `${entry.namespace}:${bare}` : bare,
        calls: workflowCallsIn(source),
      })
    }
  }

  const worlds = buildIndex(nodes)
  const resolve = (world, name) => {
    const byName = worlds.get(world)
    if (!byName) return null
    if (byName.has(name)) return byName.get(name)
    const at = name.indexOf(':')
    if (at >= 0 && byName.has(name.slice(at + 1))) return byName.get(name.slice(at + 1))
    return null
  }

  const chains = []
  for (const a of nodes) {
    for (const bName of a.calls) {
      const b = resolve(a.world, bName)
      if (!b || b.file === a.file) continue
      for (const cName of b.calls) {
        const c = resolve(b.world, cName)
        if (!c || c.file === b.file) continue
        chains.push({
          from: a.file,
          via: b.file,
          to: c.file,
          path: [a.qualified, b.qualified, c.qualified],
        })
      }
    }
  }
  return { nodes, chains }
}

function main() {
  const argv = process.argv.slice(2)
  // WHY(2026-09-12): 配られると、この走査器は配布物の中から呼ばれる。cwd 頼みだと
  //      呼び出し方次第で**プラグイン自身**を走査する（E-087）。--root が来ればそれが勝つ。
  let root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd()
  let asJson = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root') {
      root = argv[i + 1] ?? root
      i += 1
    } else if (argv[i] === '--json') {
      asJson = true
    }
  }
  root = path.resolve(root)

  const { nodes, chains } = scanWorkflowNesting(root)

  if (asJson) {
    writeLine(JSON.stringify({ scanned: nodes.length, chains }, null, 2))
  } else {
    writeLine(`Workflow ${nodes.length} 本を走査しました`)
    for (const c of chains) {
      writeLine(`NG ${c.from}: ${c.path.join(' -> ')} は 2 段の入れ子（実行時に必ず失敗する）`)
    }
    if (nodes.length > 0 && chains.length === 0) writeLine('2 段の入れ子はありません')
  }

  if (nodes.length === 0) {
    writeLine('走査できませんでした（Workflow を 1 本も見つけられない。置き場が変わった疑い）')
    process.exit(2)
  }
  process.exit(chains.length === 0 ? 0 : 1)
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
if (isRunAsCli()) main()
