// scripts/lib/scan-eval-record-shape.mjs
//
// WHY(2026-10-24・issue #907): Anthropic の 2026-09-28 の記事「Automating eval design and hillclimbing」の
//      過学習対策——train / test に分ける・eval のノイズが検出したい最小の改善より小さいかを先に確かめる・
//      ノイズ内の改善は採用しない——を、このリポジトリの eval 記録（docs/agents/eval-runs.jsonl）に
//      機械で効かせる部品。ルール文書（.claude/rules/workflow-eval-requirement.md）に書くだけだと
//      「破られても気づけない第 3 層」に落ちる（docs/agents/undetectable-rules-inventory.md）ので、
//      記録の形と採用の判定を 1 か所に置き、検査（check-eval-record-shape.test.sh）と
//      採用を書く入口（record-eval-decision.sh）の**両方がここを呼ぶ**（同じ問いに 2 か所が答えない。E-053）。
//
// 何を見るか（サブコマンド）:
//   records  <eval-runs.jsonl> [--cutoff YYYY-MM-DD]
//       記録行の形。cutoff（既定 2026-10-24 = この形を入れた日）以降の行は `split` / `runs` / `runPass` を
//       必ず持ち、`runPass` の合計が `pass` と一致し、2 run 以上なら `noiseWidth` = 最大 − 最小、
//       1 run なら `noiseWidth` を**持たない**（1 回の実行から「幅 0」とは言えない。C-025）。
//       cutoff より前の行は昔の形のまま通す（過去の記録は書き換えない）。
//   fixtures <eval-fixtures のルート> [--allow-no-test]
//       train（調整用）と test（held-out）が同じ fixture を含まないこと。判定は expected.json の
//       `heldOut` で、ファイルの中身（sha256）が train / test の両側に現れたら違反。
//       test が 1 case も無ければ落ちる（この検査が何も守らなくなる状態。本当に持たない導入先は --allow-no-test）。
//   judge    <eval-runs.jsonl> --before-train <ts> --after-train <ts> --before-test <ts> --after-test <ts>
//       4 行（変更前後 × train / test）から「採用してよいか」を JSON で返す。
//       採用の条件: 4 行すべてが 2 run 以上（ノイズ幅がある）／各対で fixtureSet・model・fixturesTree・
//       judgeBlob が同じ（条件が同じ回どうしでしか比べない）／未コミットのまま測った行が無い／
//       train と test の**両方**で、合格数の平均の改善が **4 行のノイズ幅の最大値より大きい**。
//   decisions <eval-decisions.jsonl> <eval-runs.jsonl>
//       採用の記録（record-eval-decision.sh が書く）を読み直し、`adopted` の行が今も条件を満たすか。
//
// 限界:
//   - ノイズ幅は「最大 − 最小」で、run 数が少ないほど過小に出る（3 run で見えない揺れはある）。
//     標準偏差も記録には残すが、採用の判定には使わない（小さい run 数では範囲のほうが保守的）
//   - fixture の重複は**中身の一致**だけを見る。言い換えた同型の欠陥（同じ穴を別の名前で）は追えない
//   - 「人が held-out を読んでプロンプトを直した」規律の破れは、ここでは見えない（scan-holdout-isolation.mjs の限界と同じ）
//   - cutoff 以降の行の形だけを見る。昔の形の行を**過去の日付で**手書きすれば通る（日付の偽装は見ない）

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { writeLine } from './stdout-sync.mjs'

/** この形（split / runs / runPass）を記録に入れた日。これより前の行は昔の形のまま通す */
export const SHAPE_CUTOFF = '2026-10-24'

// ---------------------------------------------------------------------------
// 共通
// ---------------------------------------------------------------------------

/** JSONL を読んで { line, row | null, raw } の配列にする（読めない行も残す） */
export function readJsonl(file) {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const out = []
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim()) return
    let row = null
    try {
      row = JSON.parse(raw)
    } catch {
      row = null
    }
    out.push({ line: i + 1, row, raw })
  })
  return out
}

const isInt = (v) => Number.isInteger(v)
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length

// ---------------------------------------------------------------------------
// records: 記録行の形
// ---------------------------------------------------------------------------

/**
 * @returns {{ rows: number, checked: number, violations: string[] }}
 *   rows    … 読んだ行数
 *   checked … 新しい形の検査対象になった行数（cutoff 以降、または新しい欄を持つ行）
 */
export function scanRecords(file, cutoff = SHAPE_CUTOFF) {
  const violations = []
  const entries = readJsonl(file)
  let checked = 0

  for (const { line, row } of entries) {
    if (!row) {
      violations.push(`unparseable: line ${line} — JSON として読めない`)
      continue
    }
    const ts = typeof row.timestamp === 'string' ? row.timestamp : ''
    const isNew = ts.slice(0, 10) >= cutoff
    const hasShape = 'split' in row || 'runs' in row || 'runPass' in row
    if (!isNew && !hasShape) continue // 昔の形。過去の記録は書き換えない
    checked++

    // 新しい形の必須欄
    for (const key of ['split', 'runs', 'runPass']) {
      if (!(key in row)) {
        violations.push(`missing-${key}: line ${line} (${ts}) — ${cutoff} 以降の記録なのに \`${key}\` が無い（手書きの行か、古い recorder）`)
      }
    }
    if ('split' in row && row.split !== 'train' && row.split !== 'test') {
      violations.push(`bad-split: line ${line} — split=${JSON.stringify(row.split)}（train / test のどちらか。mixed はセットの印が揃っていない）`)
    }
    if ('runs' in row && (!isInt(row.runs) || row.runs < 1)) {
      violations.push(`bad-runs: line ${line} — runs=${JSON.stringify(row.runs)}（1 以上の整数）`)
    }
    if ('runPass' in row) {
      if (!Array.isArray(row.runPass) || !row.runPass.every(isInt)) {
        violations.push(`bad-runPass: line ${line} — runPass は整数の配列`)
      } else {
        if (isInt(row.runs) && row.runPass.length !== row.runs) {
          violations.push(`runs-mismatch: line ${line} — runs=${row.runs} なのに runPass が ${row.runPass.length} 個`)
        }
        const sum = row.runPass.reduce((a, b) => a + b, 0)
        if (isInt(row.pass) && sum !== row.pass) {
          violations.push(`runpass-sum: line ${line} — runPass の合計 ${sum} が pass=${row.pass} と合わない`)
        }
        if (isInt(row.total) && isInt(row.runs) && row.runs > 0 && row.total % row.runs !== 0) {
          violations.push(`total-not-multiple: line ${line} — total=${row.total} が runs=${row.runs} で割り切れない`)
        }
        if (row.runPass.length >= 2) {
          const mx = Math.max(...row.runPass)
          const mn = Math.min(...row.runPass)
          if (!('noiseWidth' in row)) {
            violations.push(`missing-noise: line ${line} — ${row.runPass.length} run なのに noiseWidth が無い`)
          } else if (row.noiseWidth !== mx - mn) {
            violations.push(`noise-mismatch: line ${line} — noiseWidth=${row.noiseWidth} だが 最大 − 最小 = ${mx - mn}`)
          }
          if ('passMin' in row && row.passMin !== mn) violations.push(`min-mismatch: line ${line} — passMin=${row.passMin} ≠ ${mn}`)
          if ('passMax' in row && row.passMax !== mx) violations.push(`max-mismatch: line ${line} — passMax=${row.passMax} ≠ ${mx}`)
        } else if ('noiseWidth' in row) {
          // 1 run から「幅 0」とは言えない。採用の判定がこの欄を根拠にするので、無い状態を守る
          violations.push(`noise-on-single-run: line ${line} — 1 run の記録に noiseWidth がある（1 回の実行から幅は測れない）`)
        }
      }
    }
  }
  return { rows: entries.length, checked, violations }
}

// ---------------------------------------------------------------------------
// fixtures: train と test が同じ fixture を含まない
// ---------------------------------------------------------------------------

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

function walkFiles(dir) {
  const out = []
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(p)
    }
  }
  walk(dir)
  return out.sort()
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** case の「中身」= Sweep / エージェントが読むファイル（files/ 配下と spec.md）。expected.json・NOTES.md は含めない */
function caseContentFiles(caseDir) {
  const files = walkFiles(path.join(caseDir, 'files'))
  const spec = path.join(caseDir, 'spec.md')
  if (fs.existsSync(spec)) files.push(spec)
  return files
}

/**
 * @returns {{ trainCases: number, testCases: number, files: number, violations: string[] }}
 */
export function scanFixtures(root) {
  const violations = []
  /** sha → [{ split, label }] */
  const byHash = new Map()
  let trainCases = 0
  let testCases = 0
  let files = 0

  for (const set of listDirs(root)) {
    const setDir = path.join(root, set)
    for (const caseName of listDirs(setDir)) {
      if (!caseName.startsWith('case-')) continue
      const caseDir = path.join(setDir, caseName)
      let expected
      try {
        expected = JSON.parse(fs.readFileSync(path.join(caseDir, 'expected.json'), 'utf8'))
      } catch {
        continue
      }
      const split = expected.heldOut === true ? 'test' : 'train'
      if (split === 'test') testCases++
      else trainCases++
      for (const f of caseContentFiles(caseDir)) {
        files++
        const h = sha256(f)
        const label = `${set}/${caseName}/${path.relative(caseDir, f)}`
        if (!byHash.has(h)) byHash.set(h, [])
        byHash.get(h).push({ split, label })
      }
    }
  }

  for (const [, owners] of byHash) {
    const trainSide = owners.filter((o) => o.split === 'train')
    const testSide = owners.filter((o) => o.split === 'test')
    if (trainSide.length > 0 && testSide.length > 0) {
      violations.push(
        `shared-fixture: ${testSide.map((o) => o.label).join(', ')} と ${trainSide.map((o) => o.label).join(', ')} の中身が同一` +
          '（test は train で見た形を測り直すためのもの。同じ中身があると test の点が train の過学習を反映する）'
      )
    }
  }
  return { trainCases, testCases, files, violations }
}

// ---------------------------------------------------------------------------
// judge: 採用してよいか
// ---------------------------------------------------------------------------

/** 記録から timestamp で 1 行引く（複数あれば最初の 1 行） */
function findRow(entries, ts) {
  return entries.find((e) => e.row && e.row.timestamp === ts)?.row ?? null
}

function runMean(row) {
  if (Array.isArray(row.runPass) && row.runPass.length > 0) return mean(row.runPass)
  return typeof row.pass === 'number' ? row.pass : NaN
}

/**
 * @param {string} runsFile
 * @param {{ beforeTrain: string, afterTrain: string, beforeTest: string, afterTest: string }} refs
 * @returns {{ allowed: boolean, reasons: string[], noiseWidth: number|null, train: object|null, test: object|null }}
 */
export function judge(runsFile, refs) {
  const reasons = []
  const entries = readJsonl(runsFile)
  const rows = {}
  for (const [key, ts] of Object.entries(refs)) {
    if (!ts) {
      reasons.push(`row-missing: ${key} の timestamp が指定されていない`)
      continue
    }
    const row = findRow(entries, ts)
    if (!row) reasons.push(`row-missing: ${key}=${ts} に当たる行が ${path.basename(runsFile)} に無い`)
    rows[key] = row
  }
  if (reasons.length > 0) return { allowed: false, reasons, noiseWidth: null, train: null, test: null }

  // 1. 4 行すべてにノイズ幅がある（2 run 以上）
  for (const [key, row] of Object.entries(rows)) {
    if (!isInt(row.runs) || row.runs < 2 || !isInt(row.noiseWidth)) {
      reasons.push(`no-noise-width: ${key}=${row.timestamp} は ${row.runs ?? 1} run（ノイズ幅が無い記録は採用の根拠にできない。EVAL_RUNS=3 以上で測り直す）`)
    }
    if (row.workflowsDirty === true || row.agentsDirty === true) {
      reasons.push(`dirty-row: ${key}=${row.timestamp} は未コミットのまま測った回（測った版がコミットの版と違う）`)
    }
  }
  // 2. split が合っている
  for (const key of ['beforeTrain', 'afterTrain']) {
    if (rows[key].split !== 'train') reasons.push(`split-mismatch: ${key}=${rows[key].timestamp} は split=${rows[key].split}（train の行を指すこと）`)
  }
  for (const key of ['beforeTest', 'afterTest']) {
    if (rows[key].split !== 'test') reasons.push(`split-mismatch: ${key}=${rows[key].timestamp} は split=${rows[key].split}（test = held-out の行を指すこと）`)
  }
  // 3. 各対で条件が同じ（同じ条件の回どうしでしか比べない）
  const pairs = [
    ['train', rows.beforeTrain, rows.afterTrain],
    ['test', rows.beforeTest, rows.afterTest],
  ]
  for (const [name, before, after] of pairs) {
    for (const field of ['script', 'fixtureSet', 'model', 'fixturesTree', 'judgeBlob']) {
      if (before[field] !== after[field]) {
        reasons.push(`condition-mismatch: ${name} の ${field} が前後で違う（${before[field]} → ${after[field]}）。条件の違う回は比べない`)
      }
    }
  }
  // 4. 何かが変わっている（プロンプトか探索手順）
  const changed = pairs.some(([, b, a]) => b.workflowsTree !== a.workflowsTree || b.agentsTree !== a.agentsTree)
  if (!changed) reasons.push('nothing-changed: 前後で workflowsTree も agentsTree も同じ（何を採用するのか分からない）')

  // 5. ノイズ幅より大きい改善が train / test の両方にある
  const widths = Object.values(rows).map((r) => (isInt(r.noiseWidth) ? r.noiseWidth : NaN))
  const noiseWidth = widths.some(Number.isNaN) ? null : Math.max(...widths)
  const summarize = (before, after) => {
    const beforeMean = runMean(before)
    const afterMean = runMean(after)
    return {
      before: before.timestamp,
      after: after.timestamp,
      fixtureSet: after.fixtureSet,
      casesPerRun: isInt(after.total) && isInt(after.runs) && after.runs > 0 ? after.total / after.runs : null,
      beforeMean: Number(beforeMean.toFixed(3)),
      afterMean: Number(afterMean.toFixed(3)),
      improvement: Number((afterMean - beforeMean).toFixed(3)),
    }
  }
  const train = summarize(rows.beforeTrain, rows.afterTrain)
  const test = summarize(rows.beforeTest, rows.afterTest)
  if (noiseWidth !== null) {
    for (const [name, s] of [
      ['train', train],
      ['test', test],
    ]) {
      if (!(s.improvement > noiseWidth)) {
        reasons.push(
          `within-noise: ${name} の改善 ${s.improvement}（${s.beforeMean} → ${s.afterMean}）がノイズ幅 ${noiseWidth} 以下。` +
            'ノイズ内の改善は採用しない（run を増やして幅を縮めるか、case を増やして差を出す）'
        )
      }
    }
  }
  return { allowed: reasons.length === 0, reasons, noiseWidth, train, test }
}

// ---------------------------------------------------------------------------
// decisions: 採用の記録を読み直す
// ---------------------------------------------------------------------------

/**
 * @returns {{ decisions: number, adopted: number, violations: string[] }}
 */
export function scanDecisions(decisionsFile, runsFile) {
  const violations = []
  const entries = readJsonl(decisionsFile)
  let adopted = 0
  for (const { line, row } of entries) {
    if (!row) {
      violations.push(`unparseable: line ${line} — JSON として読めない`)
      continue
    }
    if (row.decision !== 'adopted' && row.decision !== 'rejected') {
      violations.push(`bad-decision: line ${line} — decision=${JSON.stringify(row.decision)}（adopted / rejected）`)
      continue
    }
    if (row.decision !== 'adopted') continue
    adopted++
    const refs = {
      beforeTrain: row.train?.before,
      afterTrain: row.train?.after,
      beforeTest: row.test?.before,
      afterTest: row.test?.after,
    }
    const verdict = judge(runsFile, refs)
    if (!verdict.allowed) {
      violations.push(`adopted-but-not-allowed: line ${line} (${row.timestamp}) — ${verdict.reasons.join(' / ')}`)
    }
  }
  return { decisions: entries.length, adopted, violations }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(args, name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// WHY(issue #806): import.meta.url は実体パス、argv[1] は symlink のままのことがあるので、実体パスへ直してから比べる
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
  const [cmd, ...args] = process.argv.slice(2)
  const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

  if (cmd === 'records') {
    const file = args[0] ?? path.join(REPO_ROOT, 'docs/agents/eval-runs.jsonl')
    const cutoff = argValue(args, '--cutoff') ?? SHAPE_CUTOFF
    const r = scanRecords(file, cutoff)
    if (r.rows === 0) {
      console.error(`scan-eval-record-shape: ${file} に記録が 1 行も無い（走査が壊れているか、ファイルの場所が違う）`)
      process.exit(1)
    }
    for (const v of r.violations) writeLine(v)
    writeLine(`rows=${r.rows} checked=${r.checked} violations=${r.violations.length}`)
    process.exit(r.violations.length > 0 ? 1 : 0)
  }

  if (cmd === 'fixtures') {
    const root = args[0] ?? path.join(REPO_ROOT, 'scripts/eval-fixtures')
    const r = scanFixtures(root)
    if (r.trainCases + r.testCases === 0) {
      console.error(`scan-eval-record-shape: ${root} に case が 1 つも無い（走査が壊れている）`)
      process.exit(1)
    }
    if (r.testCases === 0 && !args.includes('--allow-no-test')) {
      console.error(
        'scan-eval-record-shape: test（held-out）の case が 1 つも無い。train だけでは過学習を測れない。本当に持たないなら --allow-no-test'
      )
      process.exit(1)
    }
    for (const v of r.violations) writeLine(v)
    writeLine(`train-cases=${r.trainCases} test-cases=${r.testCases} files=${r.files} violations=${r.violations.length}`)
    process.exit(r.violations.length > 0 ? 1 : 0)
  }

  if (cmd === 'judge') {
    const file = args[0]
    if (!file) {
      console.error('usage: judge <eval-runs.jsonl> --before-train <ts> --after-train <ts> --before-test <ts> --after-test <ts>')
      process.exit(2)
    }
    const verdict = judge(file, {
      beforeTrain: argValue(args, '--before-train'),
      afterTrain: argValue(args, '--after-train'),
      beforeTest: argValue(args, '--before-test'),
      afterTest: argValue(args, '--after-test'),
    })
    writeLine(JSON.stringify(verdict))
    process.exit(0)
  }

  if (cmd === 'decisions') {
    const decisionsFile = args[0] ?? path.join(REPO_ROOT, 'docs/agents/eval-decisions.jsonl')
    const runsFile = args[1] ?? path.join(REPO_ROOT, 'docs/agents/eval-runs.jsonl')
    const r = scanDecisions(decisionsFile, runsFile)
    for (const v of r.violations) writeLine(v)
    writeLine(`decisions=${r.decisions} adopted=${r.adopted} violations=${r.violations.length}`)
    process.exit(r.violations.length > 0 ? 1 : 0)
  }

  console.error('usage: scan-eval-record-shape.mjs <records|fixtures|judge|decisions> ...')
  process.exit(2)
}
