import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WORKFLOW_FILE = path.resolve(__dirname, '../../aidd-phase2.js')
const source = readFileSync(WORKFLOW_FILE, 'utf-8')

// レビューの設計提案 2「ワークフロー: 部分成功・途中中断」。
//
// このフローには**途中で抜ける道**が 12 本ある（Spec Check / Manifest Check / Contract + DB /
// Implement / Coverage Check / Integrate / Review / Review Retry / Integrate Recheck /
// トークン上限）。どれも「done: false、blocked: true、どこで止まったか、途中までの結果」を
// 返す約束だが、**その約束を誰も機械で見ていなかった**。
//
// 抜ける道を 1 本足したときに `done` を書き忘れると、呼び出し側は `result.done` が
// undefined になり、真偽値としては false 扱いになる——つまり**たまたま**正しく止まる。
// たまたま正しいを仕組みにしない。
//
// WHY(2 回間違えて、2 回とも変異で気づいた、2026-09-10):
//   1. 最初は「インデント 0 か 2」の return だけを拾っていた。Review の差し戻しループの中にある
//      抜け道——**R01 で足した Review Retry と Integrate Recheck、つまり最も新しい 2 本**——は
//      while の中なのでインデントが深く、走査から丸ごと外れていた
//   2. 直したあとも緑のままだった。今度は照合が甘く、`done:` を**本文のどこかにあれば通す**形で、
//      `stats: { done: false, ... }` の中の同じ語に一致していた。**入れ子の中を数えていた**
//
//   どちらも「その行を実際に消す」変異で確かめて初めて分かった。**見ていない場所を
//   見ているつもりでいた**（C-022）ので、照合は必ず**トップレベルの欄**に限る。
//
// 限界: 文字列として見るだけで、実行はしない（Workflow DSL は単体で実行できない）。

/** どのインデントでも `return {` から、対応する同じインデントの `}` までを切り出す */
export function objectReturns(text) {
  const out = []
  const re = /^( *)return \{$/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const indent = m[1].length
    const start = m.index
    const closeRe = new RegExp(`^ {${indent}}\\}$`, 'm')
    const rest = text.slice(start + m[0].length)
    const c = closeRe.exec(rest)
    if (!c) continue
    out.push({ indent, body: text.slice(start, start + m[0].length + c.index + c[0].length) })
  }
  return out
}

/**
 * その return の**トップレベルの欄**に `name` があるか。
 * 入れ子（stats の中など）に同じ名前があっても数えない。
 */
function hasTopLevelKey({ indent, body }, name) {
  return new RegExp(`^ {${indent + 2}}${name}[:,]`, 'm').test(body)
}

describe('aidd-phase2.js の抜け道（部分成功・途中中断）', () => {
  const returns = objectReturns(source)
  const label = (r) => {
    const m = /blockedAt: '([^']+)'/.exec(r.body)
    return m ? m[1] : '(最終)'
  }

  it('抜け道を 1 本も見つけられなければ落ちる（走査の空振り防止）', () => {
    // 0 本なら走査が壊れている。**0 件は健全ではなく異常**（C-021）
    expect(returns.length).toBeGreaterThan(5)
  })

  it('すべての抜け道がトップレベルで done を明示している（既定値に頼らない）', () => {
    const missing = returns.filter((r) => !hasTopLevelKey(r, 'done')).map(label)
    expect(missing).toEqual([])
  })

  it('done: true をベタ書きする道は無い（最終は computeDone の結果を返す）', () => {
    const hardcoded = returns
      .filter((r) => new RegExp(`^ {${r.indent + 2}}done: true,`, 'm').test(r.body))
      .map(label)
    expect(hardcoded).toEqual([])
    expect(source).toMatch(/^ {2}done,$/m)
  })

  it('途中で抜ける道はすべて、どこで止まったかをトップレベルに持つ', () => {
    const early = returns.filter((r) => new RegExp(`^ {${r.indent + 2}}done: false,`, 'm').test(r.body))
    expect(early.length).toBeGreaterThan(5)
    const withoutWhere = early.filter((r) => !hasTopLevelKey(r, 'blockedAt')).map(label)
    expect(withoutWhere).toEqual([])
  })

  it('途中で抜ける道はすべて blocked をトップレベルに立てている', () => {
    const early = returns.filter((r) => new RegExp(`^ {${r.indent + 2}}done: false,`, 'm').test(r.body))
    const withoutBlocked = early.filter((r) => !hasTopLevelKey(r, 'blocked')).map(label)
    expect(withoutBlocked).toEqual([])
  })

  it('すべての抜け道が stats を返す（記録漏れ検知が期待件数を読めなくなる）', () => {
    // フロー完了後に record-gap-check-state.sh へ渡す期待件数は stats にしかない。
    // 途中で抜けた道が stats を返さないと、その実行だけ記録漏れ検知が空振りする
    const withoutStats = returns.filter((r) => !hasTopLevelKey(r, 'stats')).map(label)
    expect(withoutStats).toEqual([])
  })

  it('差し戻しループの中の抜け道も数えている（走査から外れやすい場所）', () => {
    // 2026-09-10 に実際に外れていた 2 本。名前で固定して、走査の縮小に気づけるようにする
    const names = returns.map(label)
    expect(names).toContain('Review Retry')
    expect(names).toContain('Integrate Recheck')
    expect(names).toContain('Review')
    expect(names).toContain('Coverage Check')
  })

  it('トークン上限の抜け道は、途中までの結果を捨てない', () => {
    // 部分成功（ここまでは出来ている）を返さないと、再開時に何が済んでいるか分からない
    expect(source).toMatch(/tokenCapReturn\('Contract \+ DB', \{ specCheck, manifestCheck \}\)/)
    expect(source).toMatch(/tokenCapReturn\('Implement', \{ manifestCheck, contractResult, dbResult \}\)/)
    expect(source).toMatch(/return tokenCapReturn\('Review', \{/)
  })
})
