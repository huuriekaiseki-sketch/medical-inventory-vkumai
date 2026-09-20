// scripts/lib/generate-codex-agents.mjs
//
// WHY(2026-09-11): agent 定義が 2 か所にあり、**同じことを二重に書いていた**。
//      `.claude/agents/*.md`（Claude）と `.codex/agents/*.toml`（Codex）。
//      実測すると、そろっているつもりの欄がずれていた:
//        - `description` が 2 本で違う（片方にだけ「読み取り専用。」が足されていた）
//        - `effort` が 6 本で違う（Claude 未指定 / Codex medium など）
//      どれも**手で写す限り、また同じことが起きる**。
//      「検知を賢くするより、間違えられる道を無くす」——**メタデータは md から生成する**。
//
// WHY(本文は生成しない、段階的にする): Codex 側の本文は Claude 側の 25〜40% に圧縮されている。
//      sweep 系では「既知の失敗パターン」「決定的な探索手順」（recall 対策そのもの）が落ちている。
//      **これが意図的かどうかはどこにも書かれていない**ので、いま写すと Codex の振る舞いが変わる。
//      本文は既存のものを保ち、**ずれは別の検査が数える**（写すかどうかは人が決める）。
//
// 写像の規則（実測して決めた。12 本すべてで一貫していた）:
//   name        ← frontmatter の name
//   description ← frontmatter の description
//   model_reasoning_effort ← frontmatter の effort（無ければ出さない）
//   sandbox_mode ← tools に `Edit` か `Write` があれば workspace-write、無ければ read-only
//
// 限界:
//   - **本文は写さない**（上記のとおり段階的にしている）
//   - `model` は写さない。Codex 側はモデルを別に選ぶ（toml に model 行が 1 本も無いことを実測）
//   - Claude 側にしか無い agent は toml を**作らない**（消すのも作るのも人が決める）
//   - グローバル（`~/.claude/agents/`）は見ない。**リポジトリに無いものは配れない**ので、
//     正本はリポジトリ内だけとする

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'

/** frontmatter を読む（雑に 1 行 1 欄。値に改行は来ない前提） */
export function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!m) return { fm: {}, body: md }
  const fm = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([a-zA-Z_]+):\s*(.*)$/)
    if (kv) fm[kv[1]] = kv[2].trim()
  }
  return { fm, body: m[2] }
}

/** tools から sandbox_mode を決める */
export function sandboxModeFor(tools) {
  return /\b(Edit|Write|MultiEdit)\b/.test(tools ?? '') ? 'workspace-write' : 'read-only'
}

/** 既存の toml から developer_instructions の中身だけを取り出す */
export function existingBody(toml) {
  const m = toml.match(/developer_instructions\s*=\s*"""([\s\S]*?)"""/)
  return m ? m[1] : null
}

/**
 * 本文のずれを数える（写さないと決めた分を、せめて見えるようにする）。
 *
 * WHY: Codex 側の本文は Claude 側の 25〜40% に圧縮されている。
 *      sweep 系では「既知の失敗パターン」「決定的な探索手順」（recall 対策そのもの）が落ちており、
 *      **それが意図的かどうかどこにも書かれていない**。
 *      写すと振る舞いが変わるので写さないが、**黙って増えていくのは止める**。
 *      「Claude 側にあって Codex 側に無い見出し」の総数を数え、上限を超えたら落とす。
 *
 * 限界: 見出し（`## `）の有無しか見ない。**中身が変わっていても気づかない**。
 */
export function countMissingSections(repoRoot) {
  const claudeDir = path.join(repoRoot, '.claude/agents')
  const codexDir = path.join(repoRoot, '.codex/agents')
  if (!fs.existsSync(claudeDir) || !fs.existsSync(codexDir)) return { total: 0, byAgent: {} }
  const byAgent = {}
  let total = 0
  for (const f of fs.readdirSync(claudeDir).filter((x) => x.endsWith('.md'))) {
    const name = f.replace(/\.md$/, '')
    const tomlPath = path.join(codexDir, `${name}.toml`)
    if (!fs.existsSync(tomlPath)) continue
    const { body: mdBody } = parseFrontmatter(fs.readFileSync(path.join(claudeDir, f), 'utf8'))
    const codexBody = existingBody(fs.readFileSync(tomlPath, 'utf8')) ?? ''
    const mdHeads = [...mdBody.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
    const codexHeads = [...codexBody.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
    // 先頭 6 文字で緩く突き合わせる（言い換えは許す。節が丸ごと無いことだけを数える）
    const missing = mdHeads.filter((h) => !codexHeads.some((c) => c.slice(0, 6) === h.slice(0, 6)))
    if (missing.length > 0) {
      byAgent[name] = missing
      total += missing.length
    }
  }
  return { total, byAgent }
}

/** toml を組み立てる（本文は呼び出し側が渡す） */
export function buildToml({ name, description, effort, tools }, body) {
  const lines = [`name = "${name}"`, `description = "${description}"`]
  if (effort) lines.push(`model_reasoning_effort = "${effort}"`)
  lines.push(`sandbox_mode = "${sandboxModeFor(tools)}"`)
  lines.push(`developer_instructions = """${body}"""`)
  return lines.join('\n') + '\n'
}

/**
 * 生成する（または照合する）。
 * @returns {{written: string[], changed: string[], missingBody: string[], onlyClaude: string[], onlyCodex: string[]}}
 */
export function generate({ repoRoot, write = false }) {
  const claudeDir = path.join(repoRoot, '.claude/agents')
  const codexDir = path.join(repoRoot, '.codex/agents')
  const result = { written: [], changed: [], missingBody: [], onlyClaude: [], onlyCodex: [] }
  if (!fs.existsSync(claudeDir) || !fs.existsSync(codexDir)) return result

  const claudeNames = fs.readdirSync(claudeDir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
  const codexNames = fs.readdirSync(codexDir).filter((f) => f.endsWith('.toml')).map((f) => f.replace(/\.toml$/, ''))

  result.onlyClaude = claudeNames.filter((n) => !codexNames.includes(n))
  result.onlyCodex = codexNames.filter((n) => !claudeNames.includes(n))

  for (const name of claudeNames) {
    if (!codexNames.includes(name)) continue
    const tomlPath = path.join(codexDir, `${name}.toml`)
    const { fm } = parseFrontmatter(fs.readFileSync(path.join(claudeDir, `${name}.md`), 'utf8'))
    const current = fs.readFileSync(tomlPath, 'utf8')
    const body = existingBody(current)
    if (body === null) {
      // 本文を取り出せない toml は触らない（壊すより止まるほうが安全）
      result.missingBody.push(name)
      continue
    }
    const next = buildToml({ name, description: fm.description ?? '', effort: fm.effort, tools: fm.tools }, body)
    if (next !== current) {
      result.changed.push(name)
      if (write) {
        fs.writeFileSync(tomlPath, next)
        result.written.push(name)
      }
    }
  }
  return result
}

// CLI: node scripts/lib/generate-codex-agents.mjs [リポジトリ] [--write]
//   既定は照合のみ（--check 相当）。差分があれば exit 1。
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
  const args = process.argv.slice(2)
  const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const repoRoot = args[0] && !args[0].startsWith('--') ? args[0] : defaultRoot
  const write = args.includes('--write')

  const r = generate({ repoRoot, write })

  for (const n of r.onlyClaude) writeLine(`only-claude: ${n}（Codex 側に toml が無い。作るかどうかは人が決める）`)
  for (const n of r.onlyCodex) writeLine(`only-codex: ${n}（正本の md がリポジトリに無い。**配れない**）`)
  for (const n of r.missingBody) writeLine(`no-body: ${n}（developer_instructions を読めない toml。触っていない）`)

  if (write) {
    for (const n of r.written) writeLine(`書き換えた: ${n}.toml`)
    writeLine(`written=${r.written.length} onlyClaude=${r.onlyClaude.length} onlyCodex=${r.onlyCodex.length}`)
    process.exit(0)
  }

  for (const n of r.changed) writeLine(`stale: ${n}.toml（md と食い違っている）`)

  const missing = countMissingSections(repoRoot)
  if (args.includes('--sections')) {
    for (const [name, list] of Object.entries(missing.byAgent)) {
      writeLine(`sections: ${name} — Codex に無い節 ${list.length} 個: ${list.join(' / ')}`)
    }
  }
  writeLine(
    `changed=${r.changed.length} onlyClaude=${r.onlyClaude.length} onlyCodex=${r.onlyCodex.length}` +
      ` noBody=${r.missingBody.length} missingSections=${missing.total}`
  )
  process.exit(r.changed.length > 0 || r.onlyCodex.length > 0 || r.missingBody.length > 0 ? 1 : 0)
}
