// docs/agents/ 等「AI エージェントが毎回読む知識庫」の腐敗を機械検知する（issue #714）。
//
// WHY: OpenAI の Harness engineering 事例（2026-02）は、AGENTS.md を「地図」、docs/ を
//      「エージェント可読の知識庫」とし、ドキュメントの腐敗（entropy）を CI で機械的に
//      抑えることを重視している。vkumai の docs/agents/ は 21 ファイル・約 300KB で、
//      相対リンク切れ・言及スクリプトの不在を検査する仕組みが無く、過去の圧縮（issue #486・
//      #542）も人手だった。意味的な陳腐化（LLM 判定）はスコープ外で、機械的に判定できる
//      3 種だけを見る:
//        1. 相対リンク（[..](./x.md)）の先のファイルが存在するか
//        2. リンクの #アンカー が、先の .md の見出しから GitHub 方式で生成した slug に一致するか
//        3. バッククォート内のリポジトリ相対パス（`scripts/x.sh` 等）が存在するか
//           （git ignore 対象のパスは CI の checkout に無いため、存在しなくても違反にしない）
//
// 見つけられること: リンク切れ・アンカー不一致・削除済みスクリプトへの言及
// 見つけられないこと: 文章内容の陳腐化、クローズ済み issue への言及（gh 依存のため未実装。issue #714 の 3 番）
//
// 使い方:
//   node scripts/lib/check-docs-integrity.mjs                 # 既定の走査対象で検査。違反があれば exit 1
//   node scripts/lib/check-docs-integrity.mjs --root <dir>    # 走査ルートを差し替え（テスト用 fixture）
//   node scripts/lib/check-docs-integrity.mjs --files a.md,b.md   # 対象ファイルを明示（--root 相対）
//   node scripts/lib/check-docs-integrity.mjs --format json   # 機械可読出力
//
// 走査対象の既定（--root 相対。存在しないものは無視）:
//   CLAUDE.md, AGENTS.md, docs/ai-config-map.md, docs/agents/**/*.md,
//   .claude/rules/**/*.md, .claude/skills/*/SKILL.md, .agents/skills/*/SKILL.md

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = path.resolve(__dirname, '../..')

// バッククォート内のパス言及として「実在検査の対象にする」先頭ディレクトリ。
// ここに無い prefix（logs/・.aidd/・node_modules/ 等）は生成物・ローカル専用なので見ない。
const PATH_MENTION_PREFIXES = ['scripts/', '.claude/', '.agents/', '.codex/', 'docs/', 'supabase/', 'src/', 'e2e/', '.github/']

// 同じ行にこれらの語があれば、そのパス言及は「もう無いことを承知で書いている」歴史的記述と
// みなして違反にしない。削除したファイルに言及する側は、読み手のためにも必ずこの語を添える
// （例: `scripts/old.sh`（削除済み、PR #424））。
export const HISTORICAL_MARKERS = ['削除済み', '廃止済み', '統合済み', '置き換え済み', '未採用', '存在しない']

export function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, files: null, format: 'text' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--root') opts.root = path.resolve(argv[++i])
    else if (a === '--files') opts.files = (argv[++i] ?? '').split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--format') opts.format = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return opts
}

function walkMd(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) out.push(...walkMd(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

export function defaultTargets(root) {
  const targets = []
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'docs/ai-config-map.md']) {
    const p = path.join(root, f)
    if (existsSync(p)) targets.push(p)
  }
  targets.push(...walkMd(path.join(root, 'docs/agents')))
  targets.push(...walkMd(path.join(root, '.claude/rules')))
  for (const base of ['.claude/skills', '.agents/skills']) {
    const dir = path.join(root, base)
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry, 'SKILL.md')
      if (existsSync(p)) targets.push(p)
    }
  }
  return targets.sort()
}

// GitHub の見出し slug 生成（github-slugger 相当）。小文字化 → 文字（L）・結合記号（M）・
// 十進数字（Nd）・文字数字（Nl）・空白・ハイフン・アンダースコア以外を除去 → 空白をハイフンに。
// ③ のような「その他の数字（No）」や記号（/ 、（ ））は除去される。同名見出しは -1, -2 … を付ける。
// 注意: github-slugger の除去規則を実機で全件照合はしていない（issue #714）。ここで通っても
// GitHub 上で飛べない場合は、この関数を GitHub の実挙動に合わせて直す。
export function slugify(headingText) {
  let t = headingText
    .replace(/`([^`]*)`/g, '$1') // インラインコードは中身だけ残す
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // リンクは表示テキストだけ残す
    .replace(/[*~]+/g, '') // 強調記号は除去
    .trim()
    .toLowerCase()
  t = t.replace(/[^\p{L}\p{M}\p{Nd}\p{Nl}\s\-_]/gu, '')
  return t.replace(/\s/g, '-')
}

export function headingSlugs(markdown) {
  const slugs = new Set()
  const seen = new Map()
  const body = stripFences(markdown)
  for (const line of body.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!m) continue
    const base = slugify(m[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    slugs.add(n === 0 ? base : `${base}-${n}`)
  }
  return slugs
}

// フェンスコードブロック（``` 〜 ```）を空行に置き換える（行番号を保つ）
export function stripFences(markdown) {
  const lines = markdown.split('\n')
  let inFence = false
  return lines
    .map(line => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence
        return ''
      }
      return inFence ? '' : line
    })
    .join('\n')
}

function isGitIgnored(root, relPath) {
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', relPath], { encoding: 'utf8' })
  return r.status === 0
}

export function checkFile(root, absFile, opts = {}) {
  const violations = []
  const rel = path.relative(root, absFile)
  const raw = readFileSync(absFile, 'utf8')
  const body = stripFences(raw)
  const lines = body.split('\n')
  const ignored = opts.isIgnored ?? (p => isGitIgnored(root, p))

  lines.forEach((line, idx) => {
    const lineNo = idx + 1
    // 1. 相対リンク（インラインコード内は除外するため、先にコードスパンを潰したコピーで探す）
    const noCode = line.replace(/`[^`]*`/g, m => ' '.repeat(m.length))
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
    let m
    while ((m = linkRe.exec(noCode)) !== null) {
      const target = m[1]
      if (/^(https?:|mailto:|tel:)/i.test(target)) continue
      const [rawPath, ...anchorParts] = target.split('#')
      const anchor = anchorParts.length ? decodeURIComponent(anchorParts.join('#')) : null
      let targetAbs = absFile
      if (rawPath) {
        targetAbs = path.resolve(path.dirname(absFile), decodeURIComponent(rawPath))
        if (!existsSync(targetAbs)) {
          violations.push({ file: rel, line: lineNo, kind: 'link', detail: `リンク先が存在しない: ${target}` })
          continue
        }
      }
      if (anchor !== null && anchor !== '') {
        if (!targetAbs.endsWith('.md')) continue
        const slugs = headingSlugs(readFileSync(targetAbs, 'utf8'))
        if (!slugs.has(anchor.toLowerCase())) {
          violations.push({ file: rel, line: lineNo, kind: 'anchor', detail: `アンカーに一致する見出しが無い: ${target}` })
        }
      }
    }

    // 3. バッククォート内のリポジトリ相対パス
    const historical = HISTORICAL_MARKERS.some(mk => line.includes(mk))
    const codeRe = /`([^`\n]+)`/g
    while ((m = codeRe.exec(line)) !== null) {
      const text = m[1].trim()
      if (!PATH_MENTION_PREFIXES.some(p => text.startsWith(p))) continue
      // 空白・glob・プレースホルダ（... / …）を含むものはコマンド例や雛形なので見ない
      if (/[\s*<>{}$|]/.test(text) || text.includes('...') || text.includes('…')) continue
      if (historical) continue
      const relPath = text.replace(/\/$/, '').replace(/[:#].*$/, '')
      if (!/^[\w./@+-]+$/.test(relPath)) continue
      const abs = path.join(root, relPath)
      if (existsSync(abs)) continue
      if (ignored(relPath)) continue
      violations.push({ file: rel, line: lineNo, kind: 'path', detail: `言及されたパスが存在しない: \`${text}\`` })
    }
  })
  return violations
}

export function run(opts) {
  const files = opts.files ? opts.files.map(f => path.resolve(opts.root, f)) : defaultTargets(opts.root)
  const violations = []
  for (const f of files) {
    if (!existsSync(f)) {
      violations.push({ file: path.relative(opts.root, f), line: 0, kind: 'missing', detail: '走査対象ファイルが存在しない' })
      continue
    }
    violations.push(...checkFile(opts.root, f, opts))
  }
  return { checkedFiles: files.length, violations }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const opts = parseArgs(process.argv.slice(2))
  const result = run(opts)
  if (opts.format === 'json') {
    console.log(JSON.stringify(result, null, 2))
  } else {
    for (const v of result.violations) console.log(`  NG: ${v.file}:${v.line} [${v.kind}] ${v.detail}`)
    console.log(`checked=${result.checkedFiles} violations=${result.violations.length}`)
  }
  process.exit(result.violations.length === 0 ? 0 : 1)
}
