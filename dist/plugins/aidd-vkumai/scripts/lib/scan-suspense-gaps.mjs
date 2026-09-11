// scripts/lib/scan-suspense-gaps.mjs
//
// WHY(2026-09-10、壊して確かめたら防御が無かった):
//      `useSearchParams()` を呼ぶ client component は `<Suspense>` の内側に無いと、
//      本番で「読み込み中」の状態を扱えず、静的生成なら**ビルドが落ちる**——
//      と Next.js の公式文書（node_modules/next/dist/docs/01-app/03-api-reference/
//      04-functions/use-search-params.md）に書いてある。
//
//      **ところがこのリポジトリでは落ちない。** 2026-09-10 に実測した:
//      Suspense 無しのページを置いて `npm run build` を回したら**成功した**（終了コード 0）。
//      理由は出力に出ている——このアプリは全ルートが `ƒ (Dynamic) server-rendered on demand` で、
//      **静的ページが 1 つも無い**。公式の防御は「静的ページのとき」しか効かない。
//
//      Sweep（LLM）も同じ日にこの欠陥を外している（sweep-ui の case-2、囮のあとの本命）。
//      **人にも LLM にもフレームワークにも頼れないので、ここで機械的に見る。**
//
// 何を見るか: `useSearchParams()` を呼ぶ .tsx を全部集め、次のどれかを満たさないものを違反にする。
//      (a) **同じファイル**に `<Suspense` がある（このリポジトリの 9 ファイルはすべてこの形）
//      (b) そのファイルから import している側が、**`<Suspense>` の内側で**その名前を使っている
//      (c) `// suspense-exempt: <理由>` が同じ行にある（理由が要る）
//
// 限界:
//   - **静的解析**。JSX の入れ子を正しく構文解析するのではなく、`<Suspense` から
//     対応する `</Suspense>` までを素朴に見る（入れ子は最初の閉じで切る）
//   - import を辿るのは 1 段だけ。孫まで包まれているかは追わない
//   - 動的 import（`next/dynamic`）で読み込む形は追えない
//   - `useSearchParams` を再輸出した別名は追えない
//
// 使い方: node scripts/lib/scan-suspense-gaps.mjs [--verbose]

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeLine } from './stdout-sync.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const HOOK_RE = /\buseSearchParams\s*\(/
const SUSPENSE_OPEN_RE = /<Suspense[\s>]/
/** 逃がす印。理由は同じ行に要る（改行をまたいで次の行を理由と読まない） */
const EXEMPT_RE = /\/\/[ \t]*suspense-exempt:[ \t]*\S/

/** ディレクトリを歩いて .tsx / .ts を集める（テストは除く） */
export function listSourceFiles(root, readdir = fs.readdirSync) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules' || e.name.startsWith('.')) continue
        walk(p)
        continue
      }
      if (!/\.tsx?$/.test(e.name)) continue
      if (/\.test\.tsx?$/.test(e.name)) continue
      out.push(p)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * `<Suspense ...>` 〜 `</Suspense>` の範囲に `<Name` が現れるか。
 *
 * WHY(素朴に見る): JSX を構文解析はしない。入れ子は最初の閉じで切るので、
 *      深く入れ子にした書き方では取りこぼす（安全側ではなく**見逃す**側なので限界に明記）。
 */
export function usedInsideSuspense(source, name) {
  let from = 0
  for (;;) {
    const open = source.indexOf('<Suspense', from)
    if (open === -1) return false
    const close = source.indexOf('</Suspense>', open)
    const region = close === -1 ? source.slice(open) : source.slice(open, close)
    if (new RegExp(`<${name}[\\s/>]`).test(region)) return true
    if (close === -1) return false
    from = close + 1
  }
}

/** そのファイルが export している値の名前（関数・const・default 名） */
export function exportedNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/export\s+(?:default\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const as = part.split(/\bas\b/)
      const n = (as[1] ?? as[0]).trim()
      if (n) names.add(n)
    }
  }
  return [...names]
}

/** `from '...'` の指す先を絶対パスに寄せる（`@/` は src/ 起点） */
export function resolveImport(spec, fromFile, srcRoot) {
  if (spec.startsWith('@/')) return path.join(srcRoot, spec.slice(2))
  if (spec.startsWith('.')) return path.resolve(path.dirname(fromFile), spec)
  return null
}

export function scan(srcRoot = path.join(REPO_ROOT, 'src'), files = null) {
  const list = files ?? listSourceFiles(srcRoot)
  const sources = new Map()
  for (const f of list) {
    try {
      sources.set(f, fs.readFileSync(f, 'utf8'))
    } catch {
      /* 読めないものは飛ばす */
    }
  }

  const callers = [...sources.entries()].filter(([, src]) => HOOK_RE.test(src))
  const violations = []

  for (const [file, src] of callers) {
    if (EXEMPT_RE.test(src)) continue
    if (SUSPENSE_OPEN_RE.test(src)) continue

    // 呼んでいる側を包んでくれる import 元を探す
    const names = exportedNames(src)
    let wrapped = false
    for (const [other, otherSrc] of sources) {
      if (other === file) continue
      if (!SUSPENSE_OPEN_RE.test(otherSrc)) continue
      // その他ファイルがこのファイルを import しているか
      let importsIt = false
      for (const m of otherSrc.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const target = resolveImport(m[1], other, srcRoot)
        if (!target) continue
        const withoutExt = file.replace(/\.tsx?$/, '')
        const asIndex = withoutExt.endsWith('/index') ? withoutExt.slice(0, -'/index'.length) : null
        if (target === withoutExt || target === file || target === asIndex) {
          importsIt = true
          break
        }
      }
      if (!importsIt) continue
      if (names.some((n) => usedInsideSuspense(otherSrc, n))) {
        wrapped = true
        break
      }
    }
    if (wrapped) continue

    violations.push(
      `suspense-gap: ${path.relative(REPO_ROOT, file)} — useSearchParams() を呼ぶのに ` +
        '<Suspense> の内側に無い（同じファイルにも、import している側にも見当たらない）。' +
        'Suspense で囲むか、意図があるなら「// suspense-exempt: 理由」を書く'
    )
  }

  return { files: list.length, callers: callers.map(([f]) => f), violations }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const srcRoot = process.env.SUSPENSE_SCAN_SRC ?? path.join(REPO_ROOT, 'src')
  const { files, callers, violations } = scan(srcRoot)

  // fail-open 防止 1: ファイルを 1 つも見つけられないと、違反ゼロで「合格」に見える
  if (files === 0) {
    console.error('scan-suspense-gaps: 対象のファイルを 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: useSearchParams を呼ぶファイルが 1 つも無いのも、走査の壊れを疑う
  //   （このリポジトリには実在する。0 件になったら探し方が変わった合図）
  if (callers.length === 0 && !process.env.SUSPENSE_SCAN_ALLOW_ZERO) {
    console.error(
      'scan-suspense-gaps: useSearchParams() を呼ぶファイルが 1 つも無い（走査が壊れている疑い）。' +
        '本当に 0 件なら SUSPENSE_SCAN_ALLOW_ZERO=1 を付ける'
    )
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    for (const c of callers) writeLine(`  ${path.relative(REPO_ROOT, c)}`)
  }
  for (const v of violations) writeLine(v)
  writeLine(`files=${files} useSearchParams-callers=${callers.length} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
