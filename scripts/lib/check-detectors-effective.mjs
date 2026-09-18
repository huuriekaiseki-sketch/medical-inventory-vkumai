#!/usr/bin/env node
// scripts/lib/check-detectors-effective.mjs
//
// WHY(C-022、2026-09-09): 「壊して落ちることを確かめずに、緑だけを見て終える」を機械化する。
//
//      検査を書いたあと、**それが本当に効いているか**は緑からは分からない。
//      判定が空振りしていても、違反が 0 件でも、出力は同じ「ALL PASSED」になる。
//      いちばん危ない外れ方（何も測っていないのに緑）は、緑を見ている限り永久に見えない。
//
//      唯一の測り方は**壊してみること**: 判定を 1 か所だけ壊し、対応するテストが
//      **本当に落ちるか**を実測する。落ちなければ、そのテストは何も守っていない。
//
//      同じ形は行単位の権限（RLS）の側にもある（導入先の変異計測。ポリシーを 1 つ壊して
//      統合テストが落ちるかを測る）。これはその**ハーネス側**の版で、
//      壊す相手が「判定エンジン」、測る相手が「その回帰テスト」になる。
//
// 1 件あたりの 1 巡:
//
//   1. **素で通ることを先に見る**（C-021: 落ちた理由が「壊したせい」だと言えるようにする）
//   2. 宣言どおり 1 か所を置換する
//   3. テストを走らせ、**落ちること**を確かめる
//   4. 元のバイト列をそのまま書き戻し、一致を確かめる
//
//   3 で落ちなければ **生き残り**。そのテストは、その判定を守っていない。
//
// WHY(置換は「1 回だけ現れる文字列」に限る): 0 回なら壊し方が陳腐化していて、
//      2 回以上なら**どこを壊したのか分からない**。どちらも「壊したつもりで壊せていない」
//      ＝ 緑が意味を持たない状態なので、生き残りと同じく違反として落とす（C-010）。
//
// WHY(元に戻すのはバイト列で): 文字列で読み書きすると改行や BOM が変わりうる。
//      Buffer のまま控え、書き戻したあと `equals` で一致を確かめる。
//      戻せなかったときは控えの置き場所を出す（黙って壊れたままにしない）。
//
// 限界:
//   - **ここに書いた壊し方しか試さない**。別の壊し方なら生き残るかもしれない
//   - 判定エンジンを足したとき、壊し方を足すのは人がやる（`minMutants` が減るのを止めるだけ）
//   - テストが落ちた理由までは見ない。「素で通り、壊すと落ちた」ことしか言えない
//   - 対象ファイルを**その場で書き換える**。同じ作業ツリーで並行して走らせてはいけない
//
// 使い方: node scripts/lib/check-detectors-effective.mjs [--registry <path>] [--root <path>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeLine } from './stdout-sync.mjs'

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = process.env.CLAUDE_PROJECT_DIR ?? path.resolve(ENGINE_DIR, '../..')

/** 宣言に必ず要る欄。1 つでも欠けたら「壊し方が書けていない」として落とす */
const REQUIRED_FIELDS = ['id', 'file', 'find', 'replace', 'expect']

/**
 * 登録簿を読んで形を確かめる。
 * ここで落とすのは「宣言そのものが壊れている」ケースだけ（実測はまだしない）。
 */
export function loadRegistry(registryPath) {
  const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  const violations = []
  const mutants = Array.isArray(raw.mutants) ? raw.mutants : []

  if (!Array.isArray(raw.mutants)) {
    violations.push('登録簿に mutants の配列がありません')
  }
  if (typeof raw.minMutants !== 'number') {
    violations.push('登録簿に minMutants（下限）がありません。下げた数を戻せなくなります')
  } else if (mutants.length < raw.minMutants) {
    violations.push(
      `壊し方が ${mutants.length} 件しかありません（下限 ${raw.minMutants} 件）。` +
        '減らすなら、なぜ測らなくてよくなったかを添えて下限も下げてください'
    )
  }

  const seen = new Set()
  for (const [i, m] of mutants.entries()) {
    const where = m?.id ?? `#${i}`
    for (const f of REQUIRED_FIELDS) {
      if (typeof m?.[f] !== 'string' || m[f] === '') violations.push(`${where}: ${f} がありません`)
    }
    if (typeof m?.id === 'string') {
      if (seen.has(m.id)) violations.push(`${m.id}: 同じ id が 2 回あります`)
      seen.add(m.id)
    }
    if (typeof m?.find === 'string' && m.find === m.replace) {
      violations.push(`${where}: find と replace が同じです（何も壊していません）`)
    }
  }

  return { mutants, minMutants: raw.minMutants, violations }
}

/**
 * `find` が本文に何回現れるかを数える。正規表現ではなく素の文字列で数える
 * （壊し方に正規表現を書かせない。書けると「当たったつもり」の余地が増える）
 */
export function countOccurrences(content, find) {
  if (find === '') return 0
  let n = 0
  let from = 0
  for (;;) {
    const at = content.indexOf(find, from)
    if (at === -1) return n
    n += 1
    from = at + find.length
  }
}

/** 既定の走らせ方。`expect` に書かれたテストを root で走らせ、終了コードだけを返す */
function defaultRunner(expectPath, root) {
  const r = spawnSync('bash', [expectPath], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  })
  return { status: r.status === null ? 1 : r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * 宣言された壊し方を 1 件ずつ実測する。
 * 返り値の各行は次のいずれか:
 *   - `killed`    素で通り、壊すと落ちた（＝その検査は効いている）
 *   - `survived`  素で通ったのに、壊しても落ちなかった（＝守っていない）
 *   - `stale`     壊し方が当たらない / どこを壊したか分からない
 *   - `redAlready` 壊す前から落ちている（比較にならない）
 *   - `notRestored` 書き戻せなかった（**この場合だけ作業ツリーが汚れたまま**）
 */
export function runMutants({ root, registryPath, runner = defaultRunner, onProgress } = {}) {
  const { mutants, violations } = loadRegistry(registryPath)
  if (violations.length > 0) return { results: [], violations, ok: false }

  const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-mutants-'))
  const results = []
  /** 同じテストを 2 回素通ししないための控え */
  const baselineCache = new Map()

  for (const m of mutants) {
    const abs = path.join(root, m.file)
    const expectAbs = path.join(root, m.expect)
    const note = (verdict, detail) => {
      const row = { id: m.id, verdict, detail, file: m.file, expect: m.expect, breaks: m.breaks }
      results.push(row)
      onProgress?.(row)
      return row
    }

    if (!fs.existsSync(abs)) {
      note('stale', `壊す相手 ${m.file} がありません`)
      continue
    }
    if (!fs.existsSync(expectAbs)) {
      note('stale', `落ちるはずのテスト ${m.expect} がありません`)
      continue
    }

    const originalBuf = fs.readFileSync(abs)
    const text = originalBuf.toString('utf8')
    const hits = countOccurrences(text, m.find)
    if (hits !== 1) {
      note(
        'stale',
        hits === 0
          ? `壊し方が当たりません（${m.file} に 0 か所）。書き換えで消えたか、字面が変わりました`
          : `壊し方が ${hits} か所に当たります。どこを壊したか言えません`
      )
      continue
    }

    // 1. 素で通ることを先に見る（C-021）
    let baseline = baselineCache.get(m.expect)
    if (baseline === undefined) {
      baseline = runner(expectAbs, root)
      baselineCache.set(m.expect, baseline)
    }
    if (baseline.status !== 0) {
      note('redAlready', `${m.expect} は壊す前から落ちています（exit ${baseline.status}）`)
      continue
    }

    // 2. 壊す（控えは repo の外に置く）
    const backupPath = path.join(backupDir, `${m.id}-${path.basename(m.file)}`)
    fs.writeFileSync(backupPath, originalBuf)
    let after
    try {
      fs.writeFileSync(abs, text.replace(m.find, m.replace), 'utf8')
      // 3. 落ちることを確かめる
      after = runner(expectAbs, root)
    } finally {
      // 4. バイト列のまま書き戻す
      fs.writeFileSync(abs, originalBuf)
    }

    if (!fs.readFileSync(abs).equals(originalBuf)) {
      note('notRestored', `${m.file} を元に戻せませんでした。控え: ${backupPath}`)
      continue
    }

    if (after.status === 0) {
      note('survived', `${m.expect} は壊しても通りました（この検査はこの判定を守っていません）`)
    } else {
      note('killed', `壊すと落ちました（exit ${after.status}）`)
    }
  }

  const ok = results.every((r) => r.verdict === 'killed')
  if (ok) fs.rmSync(backupDir, { recursive: true, force: true })
  return { results, violations: [], ok, backupDir }
}

/** 人が読む形にする。生き残りを先に出す（いちばん重い） */
export function formatReport({ results, violations, ok }) {
  const lines = []
  for (const v of violations) lines.push(`  ✗ 登録簿: ${v}`)

  const order = { survived: 0, stale: 1, redAlready: 2, notRestored: 3, killed: 4 }
  const label = {
    survived: '生き残り',
    stale: '壊し方が陳腐化',
    redAlready: '壊す前から赤い',
    notRestored: '戻せなかった',
    killed: '撃破',
  }
  for (const r of [...results].sort((a, b) => order[a.verdict] - order[b.verdict])) {
    const mark = r.verdict === 'killed' ? '✓' : '✗'
    lines.push(`  ${mark} ${r.id} [${label[r.verdict]}] ${r.breaks ?? ''}`)
    if (r.verdict !== 'killed') lines.push(`      ${r.detail}`)
  }

  const killed = results.filter((r) => r.verdict === 'killed').length
  if (ok && violations.length === 0) {
    lines.push(`  検査 ${killed} 件は、判定を壊すと確かに落ちました（C-022）`)
  } else {
    lines.push(
      `  **${results.length - killed} 件が撃破できていません**（C-022: 緑であることと守っていることは別）`
    )
  }
  return lines.join('\n')
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
if (isMain) {
  const argOf = (name, fallback) => {
    const i = process.argv.indexOf(name)
    return i === -1 ? fallback : process.argv[i + 1]
  }
  const root = path.resolve(argOf('--root', DEFAULT_ROOT))
  const registryPath = path.resolve(argOf('--registry', path.join(root, 'scripts/lib/check-mutants.json')))
  const quiet = process.argv.includes('--quiet')

  // WHY(登録簿が無い導入先): エンジンは配るが、**壊し方は導入先が決める**。
  //      登録簿が無いのは「まだ決めていない」であって違反ではないので、対象 0 件で通す
  if (!fs.existsSync(registryPath)) {
    writeLine('check-detectors-effective: 登録簿が無いので対象 0 件（scripts/lib/check-mutants.json）')
    process.exit(0)
  }

  const report = runMutants({
    root,
    registryPath,
    onProgress: quiet ? undefined : (r) => process.stderr.write(`  … ${r.id}: ${r.verdict}\n`),
  })
  writeLine(formatReport(report))
  process.exit(report.ok && report.violations.length === 0 ? 0 : 1)
}
