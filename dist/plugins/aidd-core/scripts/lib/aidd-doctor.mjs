// scripts/lib/aidd-doctor.mjs
//
// WHY(2026-09-11): 検知 hook はほぼすべて **fail-open**（判定材料が取れなければ沈黙）で設計してある。
//      壊れても何も起きないので、**hook 自身には壊れたことに気づく手段が無い**。
//      構造テスト（`scripts/*.test.sh`）はスクリプトの判定ロジックを固定するが、
//      「この環境でそもそも動くか」までは見ない。
//
//      実走ドリル（`docs/agents/hook-live-drill.md`）は同じ問題を**人が打つ手順**として持っており、
//      2026-09-05 に回して 1 日で 7 件の無音死を見つけた。だが**起動が人**なので、
//      忘れれば止まる（次回予定は四半期後）。ここはその前段——
//      **「動かす前に、動く条件が揃っているか」を機械が毎回見る**。
//
//      配布物では効き目がさらに落ちる。導入先の環境は中心リポジトリと違い、
//      `jq` や `python3` が無いことがある。そこで沈黙しても、導入先の人には
//      「検知が入っている」ようにしか見えない。
//
// 何を見るか:
//   1. hook の登録（`.claude/settings.json` と、プラグインの `hooks/hooks.json`）を列挙する
//   2. 各 hook のスクリプト**実体**を読み、必要な実行系（jq / node / python3 / npx）を**実測**する
//      （宣言表を持たない。持つと実態とずれる——C-010）
//   3. その実行系がこの環境で使えるかを見る
//   4. 使えないものに依存する hook を**名指し**で出す
//
// 限界（先に書く）:
//   - **呼び出しの有無しか見ない。** 実行時に本当にその経路を通るかは分からない
//     （`command -v jq >/dev/null || exit 0` のように、無ければ自分で降りる hook もある）
//   - **fail-open か fail-closed かは、書き方から推定するだけ。** `|| exit 0` を沈黙、
//     `|| exit 2` を拒否として読むが、分岐が複雑なものは読み切れない
//   - **合成入力で実際に発火はさせない。** それは実走ドリルの担当（この診断はその前段）
//   - **hook 以外の仕組み（CI・テストランナー）は見ない**

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

/** 実行系ごとの、呼び出しを見つける正規表現 */
const RUNTIMES = [
  { name: 'jq', re: /(?:^|[\s|(`$])jq\b/m, probe: ['jq', '--version'] },
  { name: 'python3', re: /(?:^|[\s|(`$])python3\b/m, probe: ['python3', '--version'] },
  { name: 'node', re: /(?:^|[\s|(`$])node\b/m, probe: ['node', '--version'] },
  { name: 'npx', re: /(?:^|[\s|(`$])npx\b/m, probe: ['npx', '--version'] },
]

/** その実行系が無いとき、hook がどう振る舞うか（書き方から推定する） */
function failMode(source, runtime) {
  // `command -v jq >/dev/null 2>&1 || exit 0` の類
  const silent = new RegExp(`command -v ${runtime}[^\\n]*\\|\\|[^\\n]*exit 0`).test(source)
  if (silent) return 'silent'
  const closed = new RegExp(`command -v ${runtime}[^\\n]*\\|\\|[^\\n]*exit [1-9]`).test(source)
  if (closed) return 'closed'
  return 'unknown'
}

/** hooks 設定（settings.json / hooks.json）から command を集める */
export function collectHookCommands(file) {
  if (!fs.existsSync(file)) return []
  let json
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const hooks = json.hooks ?? json
  const out = []
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      for (const h of entry.hooks ?? []) {
        if (typeof h.command === 'string') out.push({ event, command: h.command })
      }
    }
  }
  return out
}

/** command 文字列から、スクリプトのファイル名を取り出す */
export function scriptNameOf(command) {
  const m = command.match(/([\w.-]+\.(?:sh|mjs|js|py))\b/)
  return m ? m[1] : null
}

/** スクリプトの実体を探す */
function findScript(name, roots) {
  for (const root of roots) {
    for (const sub of ['scripts', 'scripts/lib', 'bin', '.']) {
      const p = path.join(root, sub, name)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

/** この環境でその実行系が使えるか */
function isAvailable(probe) {
  try {
    execFileSync(probe[0], probe.slice(1), { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

/**
 * 診断する。
 * @param {{repoRoot: string, pluginRoots?: string[], available?: Record<string, boolean>}} opts
 *   available を渡すと環境の実測を差し替えられる（テスト用の注入ポイント）
 */
export function diagnose({ repoRoot, pluginRoots = [], available = null }) {
  // WHY(Codex も見る、2026-09-11): このリポジトリは Claude と Codex の両方で作業する。
  //      Codex 側の hook は `.codex/hooks.json` にあり、**同じスクリプトを呼ぶ**ので
  //      同じ実行系に依存する。片方だけ見ると「Codex では沈黙している」に気づけない。
  //      `.codex/` が無い導入先では単に 0 件として扱う（黙る）。
  const configs = [
    { file: path.join(repoRoot, '.claude/settings.json'), tool: 'claude' },
    { file: path.join(repoRoot, '.codex/hooks.json'), tool: 'codex' },
    ...pluginRoots.map((r) => ({ file: path.join(r, 'hooks/hooks.json'), tool: 'plugin' })),
  ]
  const commands = configs.flatMap(({ file, tool }) =>
    collectHookCommands(file).map((c) => ({ ...c, tool }))
  )

  // WHY(2026-09-11): **どのイベントがどちらのツールに登録されているか**を並べる。
  //      「Codex 側には Stop hook が 1 本も無い」ことに人が目視で気づいた実例があり、
  //      それは機械が持つべき情報だった。**揃えるべきだとは言わない**——
  //      ツールごとに使えるイベントが違うので、判断は人がする。並べるところまでを機械がやる。
  const byTool = {}
  for (const c of commands) {
    ;(byTool[c.tool] ??= {})[c.event] = (byTool[c.tool][c.event] ?? 0) + 1
  }

  const roots = [repoRoot, ...pluginRoots]
  const scripts = new Map() // name -> { file, runtimes: Map<name, failMode> }
  let unresolved = 0

  for (const { command } of commands) {
    const name = scriptNameOf(command)
    if (!name) continue
    if (scripts.has(name)) continue
    const file = findScript(name, roots)
    if (!file) {
      unresolved++
      scripts.set(name, { file: null, runtimes: new Map() })
      continue
    }
    const source = fs.readFileSync(file, 'utf8')
    const runtimes = new Map()
    for (const r of RUNTIMES) {
      if (r.re.test(source)) runtimes.set(r.name, failMode(source, r.name))
    }
    scripts.set(name, { file, runtimes })
  }

  const env = {}
  for (const r of RUNTIMES) {
    env[r.name] = available ? Boolean(available[r.name]) : isAvailable(r.probe)
  }

  // 使えない実行系に依存する hook を名指しする
  const atRisk = []
  for (const [name, info] of scripts) {
    if (!info.file) continue
    for (const [runtime, mode] of info.runtimes) {
      if (env[runtime]) continue
      atRisk.push({ script: name, runtime, mode })
    }
  }

  const required = {}
  for (const r of RUNTIMES) {
    required[r.name] = [...scripts.values()].filter((s) => s.runtimes.has(r.name)).length
  }

  return {
    registrations: commands.length,
    scripts: scripts.size,
    unresolved,
    env,
    required,
    atRisk,
    byTool,
  }
}

// CLI: node scripts/lib/aidd-doctor.mjs [リポジトリ] [--plugin-root DIR]... [--verbose]
//   終了コード: 0 = 沈黙しうる hook なし / 1 = あり、または hook を 1 本も見つけられない
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const repoRoot = args[0] && !args[0].startsWith('--') ? args[0] : defaultRoot

  const pluginRoots = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--plugin-root' && args[i + 1]) pluginRoots.push(args[++i])
  }
  // 導入先ではプラグインの場所を Claude Code が環境変数で教える
  if (process.env.CLAUDE_PLUGIN_ROOT) pluginRoots.push(process.env.CLAUDE_PLUGIN_ROOT)

  // テスト用の注入ポイント: 実行系が「無い」ことにして診断する
  //   AIDD_DOCTOR_ASSUME_MISSING=jq,python3
  // WHY: 実際に jq を消して試すことはできないが、**無いときに名指しするか**は測らないと
  //      「この環境では揃っている」だけを見て終わる（C-022: 壊して落ちることを確かめない）。
  let available = null
  if (process.env.AIDD_DOCTOR_ASSUME_MISSING) {
    const missing = new Set(process.env.AIDD_DOCTOR_ASSUME_MISSING.split(','))
    available = {}
    for (const r of RUNTIMES) available[r.name] = !missing.has(r.name)
  }

  const r = diagnose({ repoRoot, pluginRoots, available })

  // fail-open 防止: hook を 1 本も見つけられなければ、「危険なし」は「探せていない」
  if (r.scripts === 0) {
    console.error('aidd-doctor: hook を 1 本も見つけられなかった（列挙が壊れている）')
    process.exit(1)
  }

  if (args.includes('--verbose')) {
    console.log(`  登録 ${r.registrations} 件 / 実体 ${r.scripts} 本（実体を見つけられず: ${r.unresolved}）`)
    for (const [k, v] of Object.entries(r.required)) {
      console.log(`  ${k}: ${v} 本が呼ぶ（この環境: ${r.env[k] ? 'あり' : '**なし**'}）`)
    }
    const tools = Object.keys(r.byTool)
    if (tools.length > 0) {
      const events = [...new Set(tools.flatMap((t) => Object.keys(r.byTool[t])))].sort()
      console.log(`  イベント別（ツールごとに使えるものが違うので、揃っていないこと自体は異常ではない）:`)
      for (const ev of events) {
        const cells = tools.map((t) => `${t}=${r.byTool[t][ev] ?? 0}`).join(' ')
        const missing = tools.filter((t) => !r.byTool[t][ev])
        const note = missing.length > 0 && missing.length < tools.length ? `  ← ${missing.join(' / ')} に無い` : ''
        console.log(`    ${ev}: ${cells}${note}`)
      }
    }
  }

  if (r.atRisk.length > 0) {
    const byRuntime = {}
    for (const a of r.atRisk) (byRuntime[a.runtime] ??= []).push(a)
    for (const [runtime, list] of Object.entries(byRuntime)) {
      const silent = list.filter((a) => a.mode === 'silent').length
      const closed = list.filter((a) => a.mode === 'closed').length
      const unknown = list.filter((a) => a.mode === 'unknown').length
      console.log(
        `aidd-doctor: ${runtime} が無いので ${list.length} 本が期待どおり動かない` +
          `（黙って降りる ${silent} / 拒否側へ倒れる ${closed} / 読み切れない ${unknown}）`
      )
      for (const a of list) console.log(`  - ${a.script}（${a.mode}）`)
    }
  }

  console.log(
    `registrations=${r.registrations} scripts=${r.scripts} atRisk=${r.atRisk.length}` +
      ` env=${Object.entries(r.env).map(([k, v]) => `${k}:${v ? 'y' : 'n'}`).join(',')}`
  )
  process.exit(r.atRisk.length > 0 ? 1 : 0)
}
