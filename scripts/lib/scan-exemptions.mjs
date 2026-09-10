// scripts/lib/scan-exemptions.mjs
//
// WHY(2026-09-10): このリポジトリの検査には、どれも「逃がし口」がある——
//      `// suspense-exempt: 理由` / `// skip-scope-ok: 理由` / `-- definer-open: 理由` /
//      `-- drops-guard: 理由`。どれも**理由を書かせている**ので、
//      1 件ずつ見れば納得できる形になっている。
//
//      **ところが、何個あるかを誰も数えていなかった。**
//      逃がし口は 1 件ずつは正当でも、増えれば検査は形骸化する
//      （「この検査はいつも例外だらけだから」と読まれなくなる）。
//      実測すると自作の印はすべて **0 件**だった——**0 のうちに上限を張る**。
//
//      同時に `eslint-disable` も数える。実測 14 件で、**うち 3 件は理由が無かった**
//      （`react-hooks/exhaustive-deps` を黙らせているだけで、なぜかが書いていない）。
//      依存配列の無効化は stale closure を招く典型なので、理由は要る。
//
// 何を見るか（プロダクトコードだけ。`src` / `supabase` / `e2e`）:
//   1. 印ごとの件数が上限（`exemption-budget.json`）以内か
//   2. 各印に**理由**が書かれているか
//      - 自作の印: `<印>: <理由>`（コロンの後に非空）
//      - eslint: `eslint-disable...  -- <理由>`（eslint 公式の書き方）
//
// 限界:
//   - **検査自身の定義・テスト・ルールブックは数えない。** 印の文字列はそこに必ず現れるので、
//     数えると常に上限を超える。裏返すと、**検査のコードに紛れ込ませた逃がし口は見えない**
//   - **印を使わずにすり抜ける書き方は分からない**（走査そのものの穴。変異計測 H-06 の担当）
//   - 理由の**中身**は見ない。「理由: あとで直す」でも通る（人が読む前提）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** 印ごとの、見つける正規表現と「理由つき」の正規表現 */
const MARKERS = [
  {
    name: 'suspense-exempt',
    find: /\/\/[ \t]*suspense-exempt[:：]/,
    withReason: /\/\/[ \t]*suspense-exempt[:：][ \t]*\S/,
  },
  {
    name: 'skip-scope-ok',
    find: /\/\/[ \t]*skip-scope-ok[:：]/,
    withReason: /\/\/[ \t]*skip-scope-ok[:：][ \t]*\S/,
  },
  {
    name: 'definer-open',
    find: /--[ \t]*definer-open[:：]/,
    withReason: /--[ \t]*definer-open[:：][ \t]*\S/,
  },
  {
    name: 'drops-guard',
    find: /--[ \t]*drops-guard[:：]/,
    withReason: /--[ \t]*drops-guard[:：][ \t]*\S/,
  },
  {
    // 型検査の抑制。`@ts-expect-error` も `@ts-ignore` も同じ扱い
    name: 'ts-suppress',
    find: /@ts-(?:expect-error|ignore)\b/,
    withReason: /@ts-(?:expect-error|ignore)\b[ \t]+\S/,
  },
  {
    // eslint 公式の理由の書き方は ` -- 理由`
    name: 'eslint-disable',
    find: /eslint-disable/,
    withReason: /eslint-disable[^\n]*--[ \t]*\S/,
  },
]

/** 中身のあるコメント行（`//` か `--` のあとに文字がある）。空の `//` は理由に数えない */
const HAS_COMMENT_TEXT = /^\s*(?:\/\/|--|\*)\s*\S/

const SEARCH_DIRS = ['src', 'supabase', 'e2e']
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'dist'])
const SOURCE_RE = /\.(tsx?|jsx?|mjs|sql)$/

export function listFiles(roots, readdir = fs.readdirSync) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (SOURCE_RE.test(e.name)) out.push(p)
    }
  }
  for (const r of roots) walk(r)
  return out.sort()
}

export function scan(roots, budget, readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const files = listFiles(roots)
  const counts = {}
  const violations = []
  const missingReason = []

  for (const m of MARKERS) counts[m.name] = 0

  for (const file of files) {
    let source
    try {
      source = readFile(file)
    } catch {
      continue
    }
    const lines = source.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const m of MARKERS) {
        if (!m.find.test(lines[i])) continue
        counts[m.name]++
        if (m.withReason.test(lines[i])) continue
        // WHY(直前のコメントも理由と認める、2026-09-10): 最初は「同じ行に ` -- 理由`」だけを
        //      認めたが、実コードを走らせたら **すぐ上に WHY コメントで理由を書いている箇所**
        //      （src/app/login/page.tsx）を「理由なし」と言った。
        //      **過検知は信用を失うので高くつく**（C-024）。
        //      直前が中身のあるコメント行なら、そこに理由があると見なす。
        //      限界: 無関係なコメントでも通る。中身までは見ない（人が読む前提）
        if (i > 0 && HAS_COMMENT_TEXT.test(lines[i - 1])) continue
        missingReason.push(`${path.relative(REPO_ROOT, file)}:${i + 1}（${m.name}）`)
      }
    }
  }

  const max = budget?.max ?? {}
  for (const m of MARKERS) {
    const limit = max[m.name]
    if (typeof limit !== 'number') {
      // 上限を書き忘れた印は「いくつでも増やせる」になる。書かせる
      violations.push(`missing-budget: ${m.name} の上限が exemption-budget.json に無い`)
      continue
    }
    if (counts[m.name] > limit) {
      violations.push(
        `over-budget: ${m.name} が ${counts[m.name]} 件（上限 ${limit}）。` +
          '逃がし口を減らすか、なぜ増やすのかを説明して上限を上げる'
      )
    }
  }
  for (const r of missingReason) {
    violations.push(`missing-reason: ${r} — 理由が書かれていない（自作の印は「印: 理由」、eslint は「 -- 理由」）`)
  }

  return { files: files.length, counts, violations }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const roots = (process.env.EXEMPTION_SCAN_ROOTS ?? SEARCH_DIRS.join(','))
    .split(',')
    .filter(Boolean)
    .map((d) => (path.isAbsolute(d) ? d : path.join(REPO_ROOT, d)))
  const budgetPath = process.env.EXEMPTION_BUDGET_FILE ?? path.join(REPO_ROOT, 'scripts/lib/exemption-budget.json')

  let budget
  try {
    budget = JSON.parse(fs.readFileSync(budgetPath, 'utf8'))
  } catch (e) {
    console.error(`scan-exemptions: 台帳を読めない（${budgetPath}）: ${e.message}`)
    process.exit(1)
  }

  const { files, counts, violations } = scan(roots, budget)

  // fail-open 防止: ファイルを 1 つも見つけられなければ、違反 0 は「探せていない」
  if (files === 0) {
    console.error('scan-exemptions: 対象のファイルを 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    console.log(`  files=${files}`)
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k}=${v}（上限 ${budget.max?.[k] ?? '未設定'}）`)
  }
  for (const v of violations) console.log(v)
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  console.log(`files=${files} exemptions=${total} violations=${violations.length}`)
  process.exit(violations.length > 0 ? 1 : 0)
}
