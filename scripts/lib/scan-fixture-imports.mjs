// scripts/lib/scan-fixture-imports.mjs
//
// WHY(2026-09-10、E-073): eval の fixture は clone したコードベースの上に**上書き配置**され、
//      Sweep はそれを実コードの一部として読む。だから fixture の `@/...` の import は
//      **実在しなければならない**。
//
//      実際に踏んだ: `sweep-data-holdout` の fixture が
//      `@/lib/security/facility-access`（存在しない）を import しており、
//      Sweep は「そのモジュールは無い」と正しく指摘した——**仕込んだ欠陥ではなく**。
//      つまりその fixture は「意図した欠陥を見つけられるか」を測っていなかった。
//
//      壊れた import は**それ自体が目立つ欠陥**なので、Sweep の注意をそこへ吸い寄せる。
//      仕込んだ欠陥が 1 つだけになるよう、import は実在するものに揃える。
//
// 何を見るか: `files/` 配下の .ts / .tsx が `from '@/...'` で参照する先が
//   (a) リポジトリの `src/` に実在する、または
//   (b) **同じ fixture が自分で置いている**（fixture が新しいモジュールを足す場合）
//   のどちらかであること。
//
// 限界:
//   - `@/` 以外（相対 import・npm パッケージ）は見ない。npm は package.json の話で、
//     相対 import は fixture 内で完結するので壊れにくい
//   - 名前付き export が実在するかは見ない（**ファイルがあるか**までしか見ない）
//   - SQL の中の関数参照（`is_facility_member` 等）は対象外

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { writeLine } from './stdout-sync.mjs'
import { realpathSync } from 'node:fs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** `from '@/x/y'` / `import '@/x/y'` の参照先を集める */
const IMPORT_RE = /(?:from|import)\s+['"]@\/([^'"]+)['"]/g

/** その参照先が実在するとみなせる拡張子の並び */
const CANDIDATES = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '']

function listFixtureSources(fixturesRoot) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(tsx?|jsx?)$/.test(e.name)) continue
      if (!p.includes(`${path.sep}files${path.sep}`)) continue
      out.push(p)
    }
  }
  walk(fixturesRoot)
  return out.sort()
}

/** その case の files/ ディレクトリ（fixture 自身が置くモジュールを探す起点） */
function filesRootOf(file) {
  const marker = `${path.sep}files${path.sep}`
  const at = file.indexOf(marker)
  return at === -1 ? null : file.slice(0, at + marker.length - 1)
}

function resolves(baseDir, spec) {
  return CANDIDATES.some((suffix) => {
    const p = path.join(baseDir, spec + suffix)
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  })
}

export function scan(fixturesRoot, repoSrc) {
  const files = listFixtureSources(fixturesRoot)
  const violations = []
  let imports = 0

  for (const file of files) {
    let source
    try {
      source = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const filesRoot = filesRootOf(file)
    for (const m of source.matchAll(IMPORT_RE)) {
      const spec = m[1]
      imports++
      // (a) リポジトリの src/ に実在する
      if (resolves(repoSrc, spec)) continue
      // (b) 同じ fixture が自分で置いている（files/src/... に配置される）
      if (filesRoot && resolves(path.join(filesRoot, 'src'), spec)) continue
      violations.push(
        `missing-import: ${path.relative(fixturesRoot, file)} が '@/${spec}' を import しているが、` +
          'リポジトリの src/ にも fixture 自身にも無い。' +
          '**壊れた import はそれ自体が目立つ欠陥**なので、Sweep の注意をそこへ吸い寄せて、' +
          '仕込んだ欠陥を測れなくする（E-073）'
      )
    }
  }

  return { files: files.length, imports, violations }
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
  const fixturesRoot = process.env.FIXTURE_IMPORTS_ROOT ?? path.join(REPO_ROOT, 'scripts/eval-fixtures')
  const repoSrc = process.env.FIXTURE_IMPORTS_SRC ?? path.join(REPO_ROOT, 'src')
  const { files, imports, violations } = scan(fixturesRoot, repoSrc)

  // fail-open 防止: fixture のソースを 1 つも見つけられなければ「違反 0」は探せていない
  if (files === 0) {
    console.error('scan-fixture-imports: fixture のソースを 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: import を 1 つも見つけられないのも探し方が変わった合図
  if (imports === 0 && !process.env.FIXTURE_IMPORTS_ALLOW_ZERO) {
    console.error(
      'scan-fixture-imports: `@/` の import が 1 つも無い（走査が壊れている疑い）。' +
        '本当に 0 件なら FIXTURE_IMPORTS_ALLOW_ZERO=1 を付ける'
    )
    process.exit(1)
  }

  for (const v of violations) writeLine(v)
  writeLine(`files=${files} imports=${imports} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
