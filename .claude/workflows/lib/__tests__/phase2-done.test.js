import { describe, it, expect } from 'vitest'
import { computeDone } from '../phase2-done.js'

const pass = { status: 'pass', detail: 'ok' }
const fail = { status: 'fail', detail: 'ng' }
const blocked = { status: 'blocked', detail: 'blocked' }

const implAllPass = [pass, pass, pass, pass, pass]

describe('computeDone', () => {
  it('全条件がpassならtrue', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], pass)).toBe(true)
  })

  it('implResultsに1件でもfailがあればfalse', () => {
    const implWithFail = [pass, pass, fail, pass, pass]
    expect(computeDone(implWithFail, pass, [pass, pass, pass, pass], pass)).toBe(false)
  })

  it('implResultsに1件でもblockedがあればfalse', () => {
    const implWithBlocked = [pass, blocked, pass, pass, pass]
    expect(computeDone(implWithBlocked, pass, [pass, pass, pass, pass], pass)).toBe(false)
  })

  it('integrationResult(test/lint/tsc)がpassでなければfalse', () => {
    expect(computeDone(implAllPass, fail, [pass, pass, pass, pass], pass)).toBe(false)
  })

  it('reviewResultsに1件でもfail(critical/high相当)があればfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, fail, pass, pass], pass)).toBe(false)
  })

  it('manifestCheck(specHash突合)がpassでなければfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], blocked)).toBe(false)
  })

  it('manifestCheckが未指定(null/undefined)でもエラーにならずfalse', () => {
    expect(computeDone(implAllPass, pass, [pass, pass, pass, pass], null)).toBe(false)
  })

  it('implResults/reviewResultsが空配列ならfalse（判定対象が無いのに完了扱いしない）', () => {
    expect(computeDone([], pass, [pass], pass)).toBe(false)
    expect(computeDone(implAllPass, pass, [], pass)).toBe(false)
  })

  it('implResultsにfindings全件minorのfailが混ざっていてもtrue（軽微な指摘のみは完了扱い）', () => {
    const minorOnlyFail = { status: 'fail', findings: [{ severity: 'minor', description: '軽微' }] }
    const implWithMinorFail = [pass, minorOnlyFail, pass, pass, pass]
    expect(computeDone(implWithMinorFail, pass, [pass, pass, pass, pass], pass)).toBe(true)
  })

  it('reviewResultsにfindings全件minorのfailが混ざっていてもtrue（軽微な指摘のみは完了扱い）', () => {
    const minorOnlyFail = { status: 'fail', findings: [{ severity: 'minor', description: '軽微' }] }
    expect(computeDone(implAllPass, pass, [pass, minorOnlyFail, pass, pass], pass)).toBe(true)
  })

  it('implResultsにfindingsでimportantが混ざるfailがあればfalse（従来通りブロック）', () => {
    const importantFail = { status: 'fail', findings: [{ severity: 'important', description: '重要' }] }
    const implWithImportantFail = [pass, importantFail, pass, pass, pass]
    expect(computeDone(implWithImportantFail, pass, [pass, pass, pass, pass], pass)).toBe(false)
  })
})
