import { describe, it, expect } from 'vitest'
import { isMinorOnlyFailure } from '../severity.js'

describe('isMinorOnlyFailure', () => {
  it('statusがpassならfalse（findingsの有無に関わらずminor-only判定の対象外）', () => {
    expect(isMinorOnlyFailure({ status: 'pass', findings: [{ severity: 'critical', description: 'x' }] })).toBe(false)
  })

  it('statusがblockedならfalse', () => {
    expect(isMinorOnlyFailure({ status: 'blocked', findings: [{ severity: 'minor', description: 'x' }] })).toBe(false)
  })

  it('statusがfailでfindings未指定ならfalse（deny-by-default: 重大度不明はブロック側）', () => {
    expect(isMinorOnlyFailure({ status: 'fail', detail: 'ng' })).toBe(false)
  })

  it('statusがfailでfindingsが空配列ならfalse', () => {
    expect(isMinorOnlyFailure({ status: 'fail', findings: [] })).toBe(false)
  })

  it('statusがfailでfindings全件minorならtrue', () => {
    expect(isMinorOnlyFailure({
      status: 'fail',
      findings: [{ severity: 'minor', description: 'a' }, { severity: 'minor', description: 'b' }],
    })).toBe(true)
  })

  it('statusがfailでfindingsにimportantが1件でも混ざればfalse', () => {
    expect(isMinorOnlyFailure({
      status: 'fail',
      findings: [{ severity: 'minor', description: 'a' }, { severity: 'important', description: 'b' }],
    })).toBe(false)
  })

  it('statusがfailでfindingsにcriticalが1件でも混ざればfalse', () => {
    expect(isMinorOnlyFailure({
      status: 'fail',
      findings: [{ severity: 'critical', description: 'a' }],
    })).toBe(false)
  })

  it('severityが不正・欠損な指摘が1件でもあればfalse（severity不明はcritical扱い）', () => {
    expect(isMinorOnlyFailure({
      status: 'fail',
      findings: [{ severity: 'minor', description: 'a' }, { description: 'severity無し' }],
    })).toBe(false)
  })

  it('resultがnull/undefinedならfalse', () => {
    expect(isMinorOnlyFailure(null)).toBe(false)
    expect(isMinorOnlyFailure(undefined)).toBe(false)
  })
})
