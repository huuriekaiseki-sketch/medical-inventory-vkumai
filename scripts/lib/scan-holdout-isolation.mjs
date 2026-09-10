// scripts/lib/scan-holdout-isolation.mjs
//
// WHY(2026-09-10、C-010「人が書いた印を実態と突き合わせない」):
//      `scripts/eval-fixtures/sweep-db-holdout/.../expected.json` には `heldOut: true` と
//      書いてあるが、**この印を読むコードはどこにも無かった**（実測: 走査して 1 件、
//      それが宣言そのもの）。印は書いた瞬間から実態とずれる。
//
//      held-out（評価専用の未公開セット）の意味は「**プロンプトや探索手順の調整に使っていない**」
//      ことにある。使ってしまえば、そのセットで高い点が出ても「過学習した」だけになる。
//      規律そのもの（人が fixture を見ないこと）は機械では測れないが、
//      **参照が漏れていないこと**は測れる——漏れていたら少なくとも規律は破れている。
//
// 何を見るか:
//   1. `*-holdout` セットの全 case が `heldOut: true` を持つ（印の付け忘れ）
//   2. `*-holdout` 以外のセットに `heldOut: true` が無い（印の付け間違い。
//      held-out のつもりで普通のセットに置くと、プロンプト調整に使われてしまう）
//   3. held-out の**名前**（セット名・case 名・`files/` 配下のファイル名）が
//      `.claude/` 配下に 1 つも出てこない（プロンプト・エージェント定義へ漏れていない）
//
// 限界:
//   - **参照が無いことは「使っていない」ことの必要条件でしかない。**
//     人が fixture を読んでプロンプトを書き換えたら、名前が出てこなくても過学習は起きる
//   - 名前で見るので、**言い換えて書かれた参照**（「holdout の SQL 関数」等）は追えない
//   - held-out の中身（欠陥の型）が既存セットと重複していないかは見ない

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const isHoldoutSet = (name) => name.endsWith('-holdout')

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** case ディレクトリの expected.json を読む（読めなければ null） */
function readExpected(caseDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'))
  } catch {
    return null
  }
}

/** files/ 配下のファイル名（拡張子つき・ディレクトリ名は含めない） */
function fixtureFileNames(caseDir) {
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
      if (e.isDirectory()) walk(p)
      else out.push(e.name)
    }
  }
  walk(path.join(caseDir, 'files'))
  return out
}

/** ディレクトリ配下のテキストを全部集める（.claude/ の走査用） */
function collectText(dir) {
  const chunks = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        // 実行時に作られるもの・複製は見ない
        if (e.name === 'worktrees' || e.name === 'node_modules' || e.name.startsWith('.eval-lock')) continue
        walk(p)
        continue
      }
      try {
        chunks.push({ file: path.relative(REPO_ROOT, p), text: fs.readFileSync(p, 'utf8') })
      } catch {
        // 読めないものは飛ばす（バイナリ等）
      }
    }
  }
  walk(dir)
  return chunks
}

export function scan(fixturesRoot, claudeDir) {
  const violations = []
  const sets = listDirs(fixturesRoot)
  const holdoutSets = sets.filter(isHoldoutSet)

  /** held-out の「名前」= セット名・case 名・fixture のファイル名 */
  const holdoutNames = new Set(holdoutSets)
  /** held-out **以外**のセットに現れる名前。共通の名前を見張ると誤検知になる */
  const sharedNames = new Set()
  let holdoutCases = 0

  for (const set of sets) {
    const setDir = path.join(fixturesRoot, set)
    for (const caseName of listDirs(setDir)) {
      const caseDir = path.join(setDir, caseName)
      const expected = readExpected(caseDir)
      if (!expected) continue
      const marked = expected.heldOut === true

      if (isHoldoutSet(set)) {
        holdoutCases++
        if (!marked) {
          violations.push(
            `holdout-unmarked: ${set}/${caseName} — *-holdout のセットなのに expected.json に heldOut: true が無い`
          )
        }
        holdoutNames.add(caseName)
        for (const f of fixtureFileNames(caseDir)) holdoutNames.add(f)
      } else {
        if (marked) {
          violations.push(
            `holdout-misplaced: ${set}/${caseName} — heldOut: true だが *-holdout のセットに入っていない` +
              '（普通のセットに置くと、プロンプト調整に使われる）'
          )
        }
        // 普通のセットにも現れる名前は「held-out 固有」ではない
        sharedNames.add(caseName)
        for (const f of fixtureFileNames(caseDir)) sharedNames.add(f)
      }
    }
  }

  // 名前がプロンプト・エージェント定義へ漏れていないか
  //
  // WHY(「held-out にしか無い名前」で絞る、2026-09-10): 最初は
  // `/holdout|eval[-_]fixture/` を含む名前だけを見張っていた。
  // ところが E-070 で fixture の名前を**業務らしい名前**へ変えた（`sterilization_logs` 等）ので、
  // その絞り込みでは **fixture のファイル名が 1 つも見張られなくなった**——
  // 印の付いた名前しか見ない判定は、印を外した瞬間に空振りする（C-011 の型）。
  // いまは「普通のセットにも現れる名前」を引いた**差集合**を見張る。
  // 短すぎる名前（`route.ts` 等）は他所にも出るので、長さでも足切りする。
  const distinctive = [...holdoutNames].filter((n) => n.length >= 12 && !sharedNames.has(n))
  const chunks = collectText(claudeDir)
  for (const name of distinctive) {
    for (const { file, text } of chunks) {
      if (text.includes(name)) {
        violations.push(
          `holdout-leaked: ${file} が held-out の名前「${name}」に触れている` +
            '（評価専用のセットは、プロンプト・探索手順から見えてはいけない）'
        )
      }
    }
  }

  return { sets: sets.length, holdoutSets: holdoutSets.length, holdoutCases, distinctive: distinctive.length, violations }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fixturesRoot = process.env.HOLDOUT_SCAN_FIXTURES ?? path.join(REPO_ROOT, 'scripts/eval-fixtures')
  const claudeDir = process.env.HOLDOUT_SCAN_CLAUDE ?? path.join(REPO_ROOT, '.claude')
  const { sets, holdoutSets, holdoutCases, distinctive, violations } = scan(fixturesRoot, claudeDir)

  // fail-open 防止 1: セットを 1 つも見つけられなければ、違反 0 は「探せていない」
  if (sets === 0) {
    console.error('scan-holdout-isolation: fixture セットを 1 つも見つけられなかった（走査が壊れている）')
    process.exit(1)
  }
  // fail-open 防止 2: held-out が 0 件なら、この検査は何も守っていない。
  //   このリポジトリには実在する（消えたら合図）。本当に持たない導入先は環境変数で明示する
  if (holdoutSets === 0 && !process.env.HOLDOUT_SCAN_ALLOW_ZERO) {
    console.error(
      'scan-holdout-isolation: held-out セット（*-holdout）が 1 つも無い。' +
        '評価専用のセットが消えると、過学習していないことを確かめる手立てが無くなる。' +
        '本当に持たないなら HOLDOUT_SCAN_ALLOW_ZERO=1 を付ける'
    )
    process.exit(1)
  }

  if (process.argv.includes('--verbose')) {
    console.log(`  セット=${sets} held-out=${holdoutSets} held-out の case=${holdoutCases} 見張る名前=${distinctive}`)
  }
  for (const v of violations) console.log(v)
  console.log(
    `sets=${sets} holdout-sets=${holdoutSets} holdout-cases=${holdoutCases} watched-names=${distinctive} violations=${violations.length}`
  )
  process.exit(violations.length > 0 ? 1 : 0)
}
