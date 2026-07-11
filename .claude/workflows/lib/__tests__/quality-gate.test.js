import { describe, it, expect } from 'vitest'
import { shouldBlock } from '../quality-gate.js'

describe('shouldBlock', () => {
  it('全結果がpassならfalse', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'pass' }])).toBe(false)
  })

  it('1件でもfailがあればtrue', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'fail' }])).toBe(true)
  })

  it('1件でもblockedがあればtrue（着手不能はfailと同様に止める）', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'blocked' }])).toBe(true)
  })

  it('nullish要素があればtrue（deny-by-default: passと確認できないものは止める）', () => {
    expect(shouldBlock([null, undefined, { status: 'pass' }])).toBe(true)
  })

  it('未知のstatus値があればtrue（deny-by-default）', () => {
    expect(shouldBlock([{ status: 'weird' }, { status: 'pass' }])).toBe(true)
  })

  it('全結果がpassの場合のみfalse', () => {
    expect(shouldBlock([{ status: 'pass' }, { status: 'pass' }])).toBe(false)
  })

  it('空配列ならfalse（判定対象自体が無い）', () => {
    expect(shouldBlock([])).toBe(false)
  })

  it('failだがfindings全件がminorならfalse（軽微な指摘のみでは差し戻さない）', () => {
    expect(shouldBlock([
      { status: 'pass' },
      { status: 'fail', findings: [{ severity: 'minor', description: 'UIの些細な指摘' }] },
    ])).toBe(false)
  })

  it('failでfindingsにimportantが混ざればtrue（従来通りブロック）', () => {
    expect(shouldBlock([
      { status: 'fail', findings: [{ severity: 'minor', description: 'a' }, { severity: 'important', description: 'b' }] },
    ])).toBe(true)
  })

  it('failでfindingsにcriticalが混ざればtrue（従来通りブロック）', () => {
    expect(shouldBlock([
      { status: 'fail', findings: [{ severity: 'critical', description: 'DBスキーマ不整合' }] },
    ])).toBe(true)
  })

  it('failでfindingsを省略した場合はtrue（deny-by-default: 重大度不明はブロック側）', () => {
    expect(shouldBlock([{ status: 'fail', detail: 'findings無し' }])).toBe(true)
  })
})
