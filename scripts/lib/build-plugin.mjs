// プラグイン v1 の生成スクリプト本体（issue #420、docs/specs/plugin-v1/SPEC.md Part 2 セット C）。
//
// WHY: 正本は vkumai の .claude/ と scripts/ のまま、配布物（プラグイン）を機械生成する。
//      7 月の試作は手コピーで、agent 名の名前空間が付かず sweep 4 体が全滅した。手順でなく
//      生成スクリプトに次を持たせ、「新しい仕組みは vkumai で先に作り、他リポジトリは受け取る
//      だけ」を構造として守る:
//        1. 層の表（scripts/lib/plugin-layout.json）に従ってファイルをコピーする。表に無い
//           ファイルは同梱しない（表を完成させる圧力）
//        2. Workflow 内の agentType / workflow() を「そのファイルを持つプラグイン名:名前」に
//           書き換える（実測 2026-09-05: agent も workflow もプラグイン名で修飾される）
//        3. @aidd-local-config マーカー区間（vkumai 固有の TRI/RISK 語彙）を空にする
//        4. agent / skill / workflow 本文の `scripts/<bin>` を bin/ 経由の裸の名前に書き換える
//           （プラグインの bin/ は Bash の PATH に足される。導入先の scripts/ は存在しない）
//        5. .claude/settings.json の hooks から hooks/hooks.json を生成し、
//           $CLAUDE_PROJECT_DIR/scripts/ を "${CLAUDE_PLUGIN_ROOT}"/scripts/ に置き換える
//        6. 検査: 共通側の禁止語（コメント込み）、同梱閉包（参照先が同じプラグイン内にある）、
//           名前空間の付け忘れ、決定性（--check で既存出力と一致）
//
// 使い方（通常は scripts/build-plugin.sh 経由）:
//   node scripts/lib/build-plugin.mjs [--out dist/plugins] [--check] [--source <repo>] [--layout <json>]
//
// 決定性: 入力（ソース・層の表・settings.json）だけから出力が決まる。タイムスタンプ・環境・
// 実行順に依存する要素を持たない。--check は一時ディレクトリに生成して既存出力と比較する。

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, rmSync, cpSync, chmodSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function parseArgs(argv) {
  const opts = { out: null, check: false, source: null, layout: null, json: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--check') opts.check = true
    else if (a === '--source') opts.source = argv[++i]
    else if (a === '--layout') opts.layout = argv[++i]
    else if (a === '--json') opts.json = true
    else throw new Error(`unknown argument: ${a}`)
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))
const SOURCE = path.resolve(opts.source ?? path.resolve(__dirname, '../..'))
const LAYOUT_FILE = path.resolve(opts.layout ?? path.join(SOURCE, 'scripts/lib/plugin-layout.json'))
const OUT = path.resolve(opts.out ?? path.join(SOURCE, 'dist/plugins'))
const layout = JSON.parse(readFileSync(LAYOUT_FILE, 'utf8'))

const errors = []
const fail = (msg) => errors.push(msg)

// ---- 補助 ----
function listFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(p)
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}
function rel(p, base) { return path.relative(base, p).split(path.sep).join('/') }
function isText(p) { return /\.(md|js|mjs|ts|sh|json|jq|txt|py)$/.test(p) }
function sha(buf) { return createHash('sha256').update(buf).digest('hex') }

// 「名前 → それを持つプラグイン」の逆引き
const ownerOf = (table, name) => layout[table]?.[name]
const pluginNames = Object.keys(layout.plugins)

// 本文中の `scripts/<bin>` → `<bin>`（bin/ は PATH に足される）
const binNames = Object.keys(layout.bin ?? {})
function rewriteBinRefs(text) {
  let t = text
  for (const b of binNames) {
    t = t.replaceAll(`scripts/${b}`, b)
  }
  return t
}

// Workflow 本文の名前空間付与と LOCAL 設定の空化
function rewriteWorkflow(text, file) {
  let t = text
  // agentType: 'name' → 'owner:name'
  t = t.replace(/agentType:\s*'([^']+)'/g, (m, name) => {
    if (name.includes(':')) return m
    const owner = ownerOf('agents', name)
    if (!owner) { fail(`${file}: agentType '${name}' は層の表 agents に無い`); return m }
    return `agentType: '${owner}:${name}'`
  })
  // workflow('name' → workflow('owner:name'
  t = t.replace(/workflow\(\s*'([^']+)'/g, (m, name) => {
    if (name.includes(':')) return m
    const owner = ownerOf('workflows', name)
    if (!owner) { fail(`${file}: workflow('${name}') は層の表 workflows に無い`); return m }
    return `workflow('${owner}:${name}'`
  })
  // @aidd-local-config:begin 〜 end を空の設定に置き換える
  const begin = t.indexOf('// @aidd-local-config:begin')
  const end = t.indexOf('// @aidd-local-config:end')
  if (begin >= 0 && end > begin) {
    const endLine = t.indexOf('\n', end)
    t = t.slice(0, begin)
      + '// @aidd-local-config:begin\n'
      + '// 導入先固有の TRI/RISK 語彙は args.riskConfig で渡す（生成時に空にした。aidd.config.json の risk を渡すこと）\n'
      + 'const LOCAL_RISK_CONFIG = {}\n'
      + '// @aidd-local-config:end'
      + t.slice(endLine)
  }
  return rewriteBinRefs(t)
}

// settings.json の hooks → プラグインごとの hooks.json
function buildHooksJson(settings, plugin) {
  const src = settings.hooks ?? {}
  const out = {}
  for (const event of Object.keys(src)) {
    const groups = []
    for (const group of src[event]) {
      const hooks = []
      for (const h of group.hooks ?? []) {
        const m = /^\$CLAUDE_PROJECT_DIR\/scripts\/([^ ]+)(.*)$/.exec(h.command ?? '')
        if (!m) { fail(`settings.json ${event}: 想定外の command 形式: ${h.command}`); continue }
        const [, script, args] = m
        if (ownerOf('hookScripts', script) !== plugin) continue
        hooks.push({ ...h, command: `"\${CLAUDE_PLUGIN_ROOT}"/scripts/${script}${args}` })
      }
      if (hooks.length > 0) groups.push({ ...group, hooks })
    }
    if (groups.length > 0) out[event] = groups
  }
  return { hooks: out }
}

// ---- 生成 ----
function build(outRoot) {
  const settings = JSON.parse(readFileSync(path.join(SOURCE, '.claude/settings.json'), 'utf8'))
  const registered = new Set()
  for (const event of Object.keys(settings.hooks ?? {})) {
    for (const g of settings.hooks[event]) for (const h of g.hooks ?? []) {
      const m = /^\$CLAUDE_PROJECT_DIR\/scripts\/([^ ]+)/.exec(h.command ?? '')
      if (m) registered.add(m[1])
    }
  }
  for (const s of registered) if (!ownerOf('hookScripts', s)) fail(`settings.json に登録された hook ${s} が層の表 hookScripts に無い`)
  for (const s of Object.keys(layout.hookScripts)) if (!registered.has(s)) fail(`層の表 hookScripts の ${s} は settings.json に登録されていない`)

  const written = {}
  const put = (plugin, relPath, content, mode) => {
    const p = path.join(outRoot, plugin, relPath)
    mkdirSync(path.dirname(p), { recursive: true })
    writeFileSync(p, content)
    if (mode) chmodSync(p, mode)
    ;(written[plugin] ??= []).push(relPath)
  }
  const copyText = (plugin, srcRel, dstRel, transform, mode) => {
    const src = path.join(SOURCE, srcRel)
    if (!existsSync(src)) { fail(`${plugin}: ソースが無い: ${srcRel}`); return }
    const text = readFileSync(src, 'utf8')
    put(plugin, dstRel, transform ? transform(text, srcRel) : text, mode)
  }

  for (const plugin of pluginNames) {
    const meta = layout.plugins[plugin]
    put(plugin, '.claude-plugin/plugin.json', JSON.stringify({
      name: plugin,
      version: meta.version,
      description: meta.description,
      dependencies: meta.dependencies ?? [],
      // hooks/hooks.json は自動で読まれる。manifest に "hooks" を書くと重複扱いで
      // "Hook load failed: Duplicate hooks file" になる（2026-09-05 プラグイン経由の実走ドリルで発見）
      generatedBy: 'AIDD plugin build (issue #420). 生成物なので手で編集しない。正本は中心リポジトリの .claude/ と scripts/',
    }, null, 2) + '\n')
    put(plugin, 'hooks/hooks.json', JSON.stringify(buildHooksJson(settings, plugin), null, 2) + '\n')
  }

  for (const [name, plugin] of Object.entries(layout.agents)) {
    copyText(plugin, `.claude/agents/${name}.md`, `agents/${name}.md`, rewriteBinRefs)
  }
  for (const [name, plugin] of Object.entries(layout.skills)) {
    const dir = path.join(SOURCE, '.claude/skills', name)
    if (!existsSync(dir)) { fail(`${plugin}: スキルが無い: ${name}`); continue }
    for (const f of listFiles(dir)) {
      const r = rel(f, dir)
      if (isText(f)) copyText(plugin, `.claude/skills/${name}/${r}`, `skills/${name}/${r}`, rewriteBinRefs)
      else put(plugin, `skills/${name}/${r}`, readFileSync(f))
    }
  }
  for (const [name, plugin] of Object.entries(layout.workflows)) {
    copyText(plugin, `.claude/workflows/${name}.js`, `workflows/${name}.js`, rewriteWorkflow)
  }
  for (const [name, plugin] of Object.entries(layout.hookScripts)) {
    copyText(plugin, `scripts/${name}`, `scripts/${name}`, null, 0o755)
  }
  // supportScripts は複数プラグインに同梱できる（値が配列）。lib/aidd-config.sh のような共通関数は
  // プラグイン間でファイルパスを跨げないため、必要な側それぞれにコピーする
  for (const [name, owners] of Object.entries(layout.supportScripts)) {
    for (const plugin of (Array.isArray(owners) ? owners : [owners])) {
      copyText(plugin, `scripts/${name}`, `scripts/${name}`, null, name.endsWith('.sh') ? 0o755 : undefined)
    }
  }
  for (const [name, plugin] of Object.entries(layout.bin ?? {})) {
    copyText(plugin, `scripts/${name}`, `bin/${name}`, null, 0o755)
  }
  // 7 項目のファイル（対応版・変更履歴・既知の制約・移行手順・破壊的変更・実証結果）を両プラグインの
  // ルートへ。設定スキーマは schema/、導入先ひな形は templates/ へ（いずれも共通側）
  const rd = layout.releaseDocs
  if (rd) {
    for (const plugin of pluginNames) {
      for (const f of rd.files ?? []) copyText(plugin, `${rd.sourceDir}/${f}`, f)
      for (const d of rd.dirs ?? []) {
        const dir = path.join(SOURCE, rd.sourceDir, d)
        if (!existsSync(dir)) { fail(`${plugin}: releaseDocs のディレクトリが無い: ${rd.sourceDir}/${d}`); continue }
        for (const f of listFiles(dir)) copyText(plugin, `${rd.sourceDir}/${d}/${rel(f, dir)}`, `${d}/${rel(f, dir)}`)
      }
    }
  }
  for (const [name, plugin] of Object.entries(layout.schema ?? {})) {
    copyText(plugin, `scripts/${name}`, `schema/${path.basename(name)}`)
  }
  for (const [srcDir, plugin] of Object.entries(layout.templates ?? {})) {
    const dir = path.join(SOURCE, srcDir)
    if (!existsSync(dir)) { fail(`${plugin}: templates のディレクトリが無い: ${srcDir}`); continue }
    for (const f of listFiles(dir)) {
      const r = rel(f, dir)
      const dst = `templates/${path.basename(srcDir)}/${r}`
      if (isText(f)) copyText(plugin, `${srcDir}/${r}`, dst)
      else put(plugin, dst, readFileSync(f))
    }
  }

  // ---- 検査 ----
  // 1. 禁止語（共通側。コメント込み、大文字小文字不問）
  for (const plugin of pluginNames) {
    if (!layout.plugins[plugin].forbiddenWords) continue
    const skip = layout.forbiddenWordsSkipPaths ?? []
    for (const r of written[plugin] ?? []) {
      const p = path.join(outRoot, plugin, r)
      if (!isText(p)) continue
      // 7 項目のファイル・ひな形は中心リポジトリ名を書く必要があるため対象外（実行されないドキュメント）
      if (skip.some(s => r === s || r.startsWith(s))) continue
      // 許容句（docs のファイル名 actuator-inventory.md 等。ファイル名の語の誤一致は既知の型）は先に消す
      let text = readFileSync(p, 'utf8').toLowerCase()
      for (const phrase of layout.forbiddenWordsAllowPhrases ?? []) text = text.replaceAll(phrase.toLowerCase(), '')
      for (const w of layout.forbiddenWords) {
        if (text.includes(w.toLowerCase())) fail(`${plugin}/${r}: 禁止語 '${w}' を含む（共通側に固有語を残さない）`)
      }
    }
  }
  // 2. 同梱閉包: 参照先が同じプラグイン内にあること（7 項目のファイル・ひな形は対象外。
  //    導入先の手順として中心リポジトリのパスを書くため）
  const allowed = layout.allowUnresolvedReferences ?? {}
  const closureSkip = layout.forbiddenWordsSkipPaths ?? []
  // bin/ はどのプラグインのものも Bash の PATH に足されるため、プラグインを跨いで参照してよい
  const allBin = new Set(Object.keys(layout.bin ?? {}).map(b => `bin/${b}`))
  for (const plugin of pluginNames) {
    const have = new Set((written[plugin] ?? []))
    for (const r of written[plugin] ?? []) {
      const p = path.join(outRoot, plugin, r)
      if (!isText(p)) continue
      if (closureSkip.some(s => r === s || r.startsWith(s))) continue
      const text = readFileSync(p, 'utf8')
      const refs = new Set()
      for (const m of text.matchAll(/scripts\/((?:lib\/)?[A-Za-z0-9_.-]+\.(?:sh|mjs|ts|jq|py))/g)) refs.add(`scripts/${m[1]}`)
      for (const m of text.matchAll(/\$SCRIPT_DIR\/((?:lib\/)?[A-Za-z0-9_.-]+\.(?:sh|mjs|ts|jq|py))/g)) refs.add(`scripts/${m[1]}`)
      if (/\.(ts|mjs)$/.test(p)) {
        for (const m of text.matchAll(/from\s+['"]\.\/([A-Za-z0-9_.-]+)['"]/g)) refs.add(`scripts/lib/${m[1]}`)
      }
      for (const ref of refs) {
        const asScript = ref
        const asBin = `bin/${ref.replace(/^scripts\//, '')}`
        if (have.has(asScript) || have.has(asBin) || allBin.has(asBin)) continue
        if (allowed[ref]) continue
        fail(`${plugin}/${r}: 参照先 ${ref} が同じプラグインに同梱されていない（層の表に足すか allowUnresolvedReferences に理由を書く）`)
      }
    }
  }
  // 3. 名前空間の付け忘れ（生成後の workflow に裸の agentType / workflow( が無い）
  for (const plugin of pluginNames) {
    for (const r of written[plugin] ?? []) {
      if (!r.startsWith('workflows/')) continue
      const text = readFileSync(path.join(outRoot, plugin, r), 'utf8')
      for (const m of text.matchAll(/agentType:\s*'([^':]+)'/g)) fail(`${plugin}/${r}: 名前空間の無い agentType '${m[1]}'`)
      for (const m of text.matchAll(/workflow\(\s*'([^':]+)'/g)) fail(`${plugin}/${r}: 名前空間の無い workflow('${m[1]}')`)
    }
  }
  return written
}

function snapshot(root) {
  const map = {}
  for (const f of listFiles(root)) map[rel(f, root)] = sha(readFileSync(f))
  return map
}

// ---- 実行 ----
const tmp = mkdtempSync(path.join(tmpdir(), 'aidd-plugin-build-'))
let written
try {
  written = build(tmp)
  if (errors.length > 0) {
    for (const e of errors) console.error(`::error::${e}`)
    console.error(`build-plugin: ${errors.length} 件のエラー。出力は書き込まない`)
    process.exit(1)
  }
  if (opts.check) {
    const want = snapshot(tmp)
    const got = snapshot(OUT)
    const diffs = []
    for (const k of Object.keys(want)) if (got[k] !== want[k]) diffs.push(`${got[k] ? '変更' : '欠落'}: ${k}`)
    for (const k of Object.keys(got)) if (!(k in want)) diffs.push(`余分: ${k}`)
    if (diffs.length > 0) {
      for (const d of diffs) console.error(`::error::dist/plugins が生成物と一致しない: ${d}`)
      console.error('bash scripts/build-plugin.sh を実行して生成物を更新してください')
      process.exit(1)
    }
    console.log(`build-plugin --check: OK（${Object.keys(want).length} ファイル一致）`)
  } else {
    for (const plugin of pluginNames) {
      const dst = path.join(OUT, plugin)
      rmSync(dst, { recursive: true, force: true })
      mkdirSync(path.dirname(dst), { recursive: true })
      cpSync(path.join(tmp, plugin), dst, { recursive: true })
    }
    const summary = Object.fromEntries(pluginNames.map(p => [p, (written[p] ?? []).length]))
    if (opts.json) console.log(JSON.stringify({ out: OUT, files: summary }, null, 2))
    else console.log(`build-plugin: ${OUT} に生成（${pluginNames.map(p => `${p}: ${summary[p]} ファイル`).join(' / ')}）`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
