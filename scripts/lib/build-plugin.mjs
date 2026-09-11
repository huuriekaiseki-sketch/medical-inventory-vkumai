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
  const opts = { out: null, check: false, source: null, layout: null, json: false, marketplace: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') opts.out = argv[++i]
    else if (a === '--check') opts.check = true
    // --marketplace: 出力先の親（配布リポジトリのルート）に .claude-plugin/marketplace.json と README を書く
    else if (a === '--marketplace') opts.marketplace = true
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
// 配布物の同一性（issue #757 の 37）。scripts/check-plugin-integrity.sh と同じ名前を使う
const MANIFEST_NAME = '.aidd-manifest.json'
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
      author: layout.marketplace?.owner,
      // hooks/hooks.json は自動で読まれる。manifest に "hooks" を書くと重複扱いで
      // "Hook load failed: Duplicate hooks file" になる（2026-09-05 プラグイン経由の実走ドリルで発見）。
      // 生成元の注記は Claude Code が読まない自由領域 metadata に置く（validate の Unknown field 警告を避ける）
      metadata: { generatedBy: 'AIDD plugin build (issue #420). 生成物なので手で編集しない。正本は中心リポジトリの .claude/ と scripts/' },
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
  // bin/ に置くスクリプトは scripts/ から 1 階層ずれるため、スクリプト位置基準の参照を書き換える
  // （2026-09-05 プラグイン経由の fault-injection 実走で `bin/lib/resolve-log-dir.sh: No such file` を発見）。
  // .claude/workflows/lib/ の純粋関数は scripts/workflow-lib/ へ同梱し、そちらを指す
  const rewriteBin = (text) => text
    .replaceAll('"$SCRIPT_DIR/lib/', '"$SCRIPT_DIR/../scripts/lib/')
    .replaceAll('"$SCRIPT_DIR/../.claude/workflows/lib/', '"$SCRIPT_DIR/../scripts/workflow-lib/')
  for (const [name, plugin] of Object.entries(layout.bin ?? {})) {
    copyText(plugin, `scripts/${name}`, `bin/${name}`, rewriteBin, 0o755)
  }
  for (const [name, plugin] of Object.entries(layout.workflowLib ?? {})) {
    if (name.startsWith('_')) continue
    copyText(plugin, `.claude/workflows/lib/${name}`, `scripts/workflow-lib/${name}`)
  }
  // 検査（*.test.sh）を同梱する（issue #757 の 19 の教訓）。
  // WHY: これまで hook 本体だけを配り、その hook を守る検査と、hook を持たない構造テスト
  //      （カタログの形・索引の抜け・秘密情報の走査）は 1 本も配っていなかった。
  //      派生先には「止める仕組み」だけが渡り、「その仕組みが壊れていないことを確かめる手段」が
  //      渡らない状態だった。ルールを配るなら、そのルールの検査も一緒に配る。
  //
  //      対象スクリプトを持つ検査（check-x.sh に対する check-x.test.sh）は、
  //      対象と同じプラグインへ自動的に付いていく（層の表に二重登録しない）。
  //      対象を持たない構造テストだけを layout.checks に書く。
  const testOwners = {}
  const declareTest = (base, plugin) => {
    const t = base + '.test.sh'
    if (!existsSync(path.join(SOURCE, 'scripts', t))) return
    ;(testOwners[t] ??= new Set()).add(plugin)
  }
  for (const [name, plugin] of Object.entries(layout.hookScripts)) declareTest(name.replace(/\.sh$/, ''), plugin)
  for (const [name, owners] of Object.entries(layout.supportScripts)) {
    for (const plugin of (Array.isArray(owners) ? owners : [owners])) {
      declareTest(name.replace(/\.(sh|mjs|ts|jq)$/, ''), plugin)
    }
  }
  for (const [name, plugin] of Object.entries(layout.bin ?? {})) declareTest(name.replace(/\.sh$/, ''), plugin)
  // layout.checks は「対象を持たない構造テスト」の宣言と、自動で決まった層の上書きを兼ねる。
  // 上書きが要るのは、仕組みは汎用でも fixture がこのリポジトリの語彙で書かれている検査
  // （高リスクパスの例・ドメイン語・スタック名）。共通側に固有語は置けないのでアダプター側へ回す。
  for (const [name, owners] of Object.entries(layout.checks ?? {})) {
    if (name.startsWith('_')) continue
    testOwners[name] = new Set(Array.isArray(owners) ? owners : [owners])
  }
  // 配らない検査（理由つき）。中身が導入先に無いものを検査していて、配ると必ず落ちるもの
  for (const name of Object.keys(layout.checksNotDistributed ?? {})) {
    if (name.startsWith('_')) continue
    delete testOwners[name]
  }
  for (const [name, plugins] of Object.entries(testOwners)) {
    for (const plugin of plugins) copyText(plugin, 'scripts/' + name, 'scripts/' + name, null, 0o755)
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
  // WHY(2026-09-11): **死んだ免除は、同じ参照が将来また入ったときに黙って通す。**
  //      しかも理由は別の文脈で書かれたものなので、読んだ人は納得してしまう。
  //      実測すると 51 件中 15 件が一度も当たっていなかった（逃がし口は放っておくと腐る）。
  //      当たった鍵を数えて、当たらなかったものを落とす。
  const allowedUsed = new Set()
  const closureSkip = layout.forbiddenWordsSkipPaths ?? []
  // bin/ はどのプラグインのものも Bash の PATH に足されるため、プラグインを跨いで参照してよい
  const allBin = new Set(Object.keys(layout.bin ?? {}).map(b => `bin/${b}`))
  for (const plugin of pluginNames) {
    const have = new Set((written[plugin] ?? []))
    for (const r of written[plugin] ?? []) {
      const p = path.join(outRoot, plugin, r)
      if (!isText(p)) continue
      if (closureSkip.some(s => r === s || r.startsWith(s))) continue
      // 検査（*.test.sh）は fixture として存在しないファイル名を書く（scripts/check-a.sh のような
      // 架空の名前を一時ディレクトリに作って検知力を試す）。それを実行時参照と見なすと
      // 際限なく allowUnresolvedReferences が増えるので、検査については
      // 「対象スクリプトが同梱されているか」だけを見る（本当に困るのはそこだけ）。
      if (/\.test\.sh$/.test(r)) {
        const subject = r.replace(/\.test\.sh$/, '.sh')
        // bin/ へ置き換えられるスクリプト（進捗記録など）は scripts/ ではなく bin/ に同梱される
        const asBinSubject = 'bin/' + path.posix.basename(subject)
        if (existsSync(path.join(SOURCE, subject)) && !have.has(subject) && !have.has(asBinSubject)) {
          fail(`${plugin}/${r}: 対象の ${subject} が同じプラグインに無い（検査だけ配っても動かない）`)
        }
        continue
      }
      const text = readFileSync(p, 'utf8')
      const refs = new Set()
      for (const m of text.matchAll(/scripts\/((?:lib\/)?[A-Za-z0-9_.-]+\.(?:sh|mjs|ts|jq|py))/g)) refs.add(`scripts/${m[1]}`)
      // $SCRIPT_DIR 基準の参照は、置き場所に応じて実体の位置へ解決する（bin/ は書き換え後の
      // `$SCRIPT_DIR/../scripts/...` を bin 基準で、scripts/ 配下は従来どおり scripts 基準で解決。
      // lib/ の中の使い方コメント「$SCRIPT_DIR/lib/…」は hook から見た書き方なので scripts 基準でよい）
      const selfDir = r.startsWith('bin/') ? 'bin' : 'scripts'
      for (const m of text.matchAll(/\$SCRIPT_DIR\/((?:\.\.\/)*(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:sh|mjs|ts|jq|py|js))/g)) {
        refs.add(path.posix.normalize(`${selfDir}/${m[1]}`))
      }
      // シェルからの .claude/workflows/lib/ 直接参照（node で呼ぶ。同梱されていなければ導入先で落ちる）。
      // workflow / mjs のコメント内の「正本は .claude/workflows/lib/…」は実行時参照ではないため対象外
      if (r.endsWith('.sh')) {
        for (const m of text.matchAll(/\.claude\/workflows\/lib\/([A-Za-z0-9_.-]+\.js)/g)) refs.add(`scripts/workflow-lib/${m[1]}`)
      }
      if (/\.(ts|mjs|js)$/.test(p) && !r.startsWith('workflows/')) {
        for (const m of text.matchAll(/from\s+['"]\.\/([A-Za-z0-9_.-]+)['"]/g)) refs.add(`${path.posix.dirname(r)}/${m[1]}`)
      }
      for (const ref of refs) {
        const asScript = ref
        const asBin = `bin/${ref.replace(/^scripts\//, '')}`
        if (have.has(asScript) || have.has(asBin) || allBin.has(asBin)) continue
        if (allowed[ref]) { allowedUsed.add(ref); continue }
        // 同梱前の元パス表記（scripts/lib/x）で allow に書かれているものは、置き場所違いでも許容
        const legacyKey = `scripts/${ref.replace(/^scripts\/workflow-lib\//, 'lib/')}`
        if (allowed[legacyKey]) { allowedUsed.add(legacyKey); continue }
        fail(`${plugin}/${r}: 参照先 ${ref} が同じプラグインに同梱されていない（層の表に足すか allowUnresolvedReferences に理由を書く）`)
      }
    }
  }
  // 2b. 逃がし口の衛生: 使われていない免除を残さない／理由を空にしない／件数の上限
  //
  // WHY(この規則を隣へ広げないこと。2026-09-11 に実測して確かめた): 同じ扱いをしてよいのは
  //     **1 件ずつの免除**（この一覧は「この参照を許す」という個別の宣言）だけ。
  //     `forbiddenWordsSkipPaths` は**種類ごとの方針**（「リリース文書は禁止語の対象外」）で、
  //     いま中身に禁止語が無くても次の版で書かれる。実測では COMPATIBILITY.md と BREAKING.md が
  //     「今は禁止語を含まない」状態だったが、これを理由に外すと**一度も通らない道**を作る（C-024）。
  //     `forbiddenWordsAllowPhrases` は 3 件とも実際に使われていた（腐っていない）。
  for (const [key, reason] of Object.entries(allowed)) {
    if (key.startsWith('_')) continue
    if (!String(reason ?? '').trim()) {
      fail(`allowUnresolvedReferences: ${key} の理由が空（なぜ同梱しなくてよいかを書く）`)
    }
    if (!allowedUsed.has(key)) {
      fail(`allowUnresolvedReferences: ${key} は一度も当たっていない（消す。残すと同じ参照が戻ったとき別の文脈の理由で黙って通る）`)
    }
  }
  // ratchet: 逃がし口は放っておくと増える。増やすときは人が上限を上げる（減らすのは自由）。
  // 逃がし口が 1 つも無い導入先には上限を書かせない（0 件のままなら見張る対象が無い）
  const allowMax = layout.allowUnresolvedReferencesMax
  const allowCount = Object.keys(allowed).filter((k) => !k.startsWith('_')).length
  if (allowCount > 0 && typeof allowMax !== 'number') {
    fail('allowUnresolvedReferencesMax が層の表に無い（逃がし口が増えても気づけない）')
  } else if (typeof allowMax === 'number' && allowCount > allowMax) {
    fail(`allowUnresolvedReferences が ${allowCount} 件で上限 ${allowMax} を超えた（同梱するか、上限を上げる理由を書く）`)
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
  // 4. 配布物の同一性（issue #757 の 37）。生成した全ファイルの sha256 を .aidd-manifest.json に書く。
  //    導入先では SessionStart hook（check-plugin-integrity.sh）がこの表と実物を突き合わせ、
  //    配布経路での差し替え・部分適用・手編集を検知する。
  //    written には入れない（禁止語・同梱閉包の検査対象にせず、内容も検査結果に影響させないため）。
  //    中身は sha256 とパスだけで、時刻・ホスト名・版などの揺れる値を入れない（決定性のため）。
  for (const plugin of pluginNames) {
    const files = {}
    for (const r of (written[plugin] ?? []).slice().sort()) {
      files[r] = sha(readFileSync(path.join(outRoot, plugin, r)))
    }
    writeFileSync(
      path.join(outRoot, plugin, MANIFEST_NAME),
      JSON.stringify({ plugin, algorithm: 'sha256', files }, null, 2) + '\n'
    )
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
    if (opts.marketplace) {
      // 配布形態 (a): 出力先 <repo>/plugins の親に marketplace の manifest を置く（layout.marketplace が正本）
      const mp = layout.marketplace
      if (!mp) throw new Error('--marketplace には layout.marketplace が必要')
      const repoRoot = path.dirname(OUT)
      const manifest = {
        name: mp.name,
        owner: mp.owner,
        description: mp.description,
        metadata: { pluginRoot: `./${path.basename(OUT)}` },
        plugins: pluginNames.map(p => ({
          name: p,
          source: p,
          description: layout.plugins[p].description,
          version: layout.plugins[p].version,
        })),
      }
      mkdirSync(path.join(repoRoot, '.claude-plugin'), { recursive: true })
      writeFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), JSON.stringify(manifest, null, 2) + '\n')
      const readme = [
        `# ${mp.name}`,
        '',
        mp.description,
        '',
        '## 使い方',
        '',
        '```bash',
        `claude plugin marketplace add ${mp.repo}`,
        ...pluginNames.map(p => `claude plugin install ${p}@${mp.name}`),
        '```',
        '',
        '## 中身',
        '',
        ...pluginNames.map(p => `- \`plugins/${p}\` ${layout.plugins[p].version}: ${layout.plugins[p].description}`),
        '',
        '生成物。手で編集しない。正本は中心リポジトリの `.claude/` と `scripts/`、生成は `scripts/build-plugin.sh --marketplace --out <このリポジトリ>/plugins`。',
        '各プラグインのルートに COMPATIBILITY / CHANGELOG / KNOWN-LIMITS / MIGRATION / BREAKING と evidence/ がある。',
        '',
      ].join('\n')
      writeFileSync(path.join(repoRoot, 'README.md'), readme)
    }
    const summary = Object.fromEntries(pluginNames.map(p => [p, (written[p] ?? []).length]))
    if (opts.json) console.log(JSON.stringify({ out: OUT, files: summary }, null, 2))
    else console.log(`build-plugin: ${OUT} に生成（${pluginNames.map(p => `${p}: ${summary[p]} ファイル`).join(' / ')}）`)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
