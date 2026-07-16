import { describe, it, expect } from 'vitest'
import { isSpecCheckPathMismatch } from '../spec-check.js'

describe('isSpecCheckPathMismatch', () => {
  it('statusがpassでactualPathが指定specPathで終わっていればfalse（一致・不一致なし）', () => {
    const specCheck = { status: 'pass', detail: 'ok', actualPath: '/repo/SPEC.md' }
    expect(isSpecCheckPathMismatch(specCheck, 'SPEC.md')).toBe(false)
  })

  it('statusがpassでactualPathが指定specPath（サブディレクトリ）で終わっていればfalse', () => {
    const specCheck = {
      status: 'pass',
      detail: 'ok',
      actualPath: '/repo/.claude/workflows/__fixtures__/fault-injection/missing-spec/SPEC.md',
    }
    expect(isSpecCheckPathMismatch(specCheck, '.claude/workflows/__fixtures__/fault-injection/missing-spec/SPEC.md')).toBe(false)
  })

  it('statusがpassでactualPathが指定specPathと異なるファイルを指していればtrue（issue #399の再現ケース）', () => {
    const specCheck = {
      status: 'pass',
      detail: 'SPEC.mdが存在し読み込めた',
      actualPath: '/repo/SPEC.md',
    }
    expect(isSpecCheckPathMismatch(specCheck, '.claude/workflows/__fixtures__/fault-injection/missing-spec/SPEC.md')).toBe(true)
  })

  it('statusがblockedならactualPathが不一致でもfalse（既存のblocked判定に委ねる）', () => {
    const specCheck = { status: 'blocked', detail: '存在しない', actualPath: '/repo/SPEC.md' }
    expect(isSpecCheckPathMismatch(specCheck, 'SPEC.md')).toBe(false)
  })

  it('actualPathが欠落していればfalse（従来のstatusベース判定に委ねる）', () => {
    const specCheck = { status: 'pass', detail: 'ok' }
    expect(isSpecCheckPathMismatch(specCheck, 'SPEC.md')).toBe(false)
  })
})
