#!/usr/bin/env node
// WHY: 2026-09-07。`.gitattributes` の `merge=union` は**衝突を報告しない**。
//      同じ行を両側が別々に書き換えると、片方を選ぶのではなく**両方の行が並んで残る**。
//      ID 列のあるルールブック（I / P / TB / E）は `check-catalog.mjs` の ID 重複検査が落とすが、
//      **ID 列を持たない棚卸し表には検知が 1 つも無かった**（`.gitattributes` の「既知の限界」に
//      挙がっている検知先にも、その 4 ファイルは入っていなかった）。
//
//      実害: 2026-09-07 に 40 本のブランチをマージした後、`security-test-catalog.md` に 7 組・
//      `test-matrix.md` に 1 組の重複が残っていた。**どの組も「計画のまま・根拠列が空」の古い版と
//      「実装済み＋根拠つき」の新しい版**で、古い版を読むと「まだやっていない」と誤読する。
//      union merge を続ける以上、人が目で見つける前提にはできない。
//
// 既知の限界:
//   - 見るのは**鍵の列が重複していないか**だけ。同じ観点を別の名前で 2 行書いた重複や、
//     内容が矛盾している 2 行は見つけられない。
//   - **どちらが新しいかは判定できない。落とすだけで直さない**（人が中身を読んで選ぶ）。
//   - 鍵の列は下の TABLES に手で書く。表を足したらここにも足す（**足し忘れは検知できない**）。
//   - 1 ファイルに表が複数あっても鍵は共通に見る。別の表に同じ名前の行があると誤検知するので、
//     そのときは鍵の列を分ける設計に直すこと（現状の 5 ファイルでは起きていない）。

import { readFileSync } from 'node:fs'

/** ファイル → 行を一意にする列（1 始まり）。`.gitattributes` の union 対象のうち ID 検査が無いもの */
export const TABLES = [
  { file: 'docs/agents/security-test-catalog.md', keyColumn: 1, keyName: '観点' },
  { file: 'docs/agents/test-matrix.md', keyColumn: 1, keyName: '種別' },
  // 1 列目は hook イベント名で、同じイベントに複数の hook がぶら下がるのが正常。
  // 一意なのはスクリプト名（2 列目）。
  { file: 'docs/agents/actuator-inventory.md', keyColumn: 2, keyName: 'スクリプト' },
  { file: 'docs/agents/portability-inventory.md', keyColumn: 1, keyName: '対象' },
  { file: 'docs/agents/undetectable-rules-inventory.md', keyColumn: 1, keyName: 'ルール' },
]

const SEPARATOR = /^\|[-:\s|]+\|$/

function cellsOf(trimmedLine) {
  return trimmedLine.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
}

/**
 * 鍵の列が重複している行を返す。
 * 表は「見出し行 → 区切り行 → データ行...」の順なので、区切り行を見てからデータ行を数える。
 * 表以外の行が挟まったら別の表として数え直す（1 ファイルに表が複数あるため）。
 */
export function findDuplicates(file, keyColumn, text) {
  const violations = []
  let seen = new Map()
  let inData = false

  text.split('\n').forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) {
      inData = false
      return
    }
    if (SEPARATOR.test(trimmed)) {
      inData = true
      return
    }
    if (!inData) return // 見出し行

    const key = cellsOf(trimmed)[keyColumn - 1] ?? ''
    if (key === '') return
    if (seen.has(key)) {
      violations.push({ file, key, lines: [seen.get(key), index + 1] })
    } else {
      seen.set(key, index + 1)
    }
  })

  void seen
  return violations
}

export function checkAll(root = '.') {
  const violations = []
  for (const { file, keyColumn, keyName } of TABLES) {
    const text = readFileSync(`${root}/${file}`, 'utf8')
    for (const v of findDuplicates(file, keyColumn, text)) violations.push({ ...v, keyName })
  }
  return violations
}

if (process.argv[1] && process.argv[1].endsWith('check-table-row-duplicates.mjs')) {
  const violations = checkAll(process.argv[2] ?? '.')
  for (const v of violations) {
    console.error(`NG ${v.file}: ${v.keyName} "${v.key}" が ${v.lines.join(' 行と ')} 行に重複しています`)
  }
  if (violations.length > 0) {
    console.error('')
    console.error('merge=union は衝突を報告せず両方の行を残します。**どちらが新しいか**を中身で判断し、')
    console.error('古い方（多くは「計画のまま・根拠列が空」）を消してください。')
    process.exit(1)
  }
  console.log(`checked=${TABLES.length} violations=0`)
}
