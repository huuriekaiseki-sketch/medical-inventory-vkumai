import { describe, it, expect } from 'vitest'
import { computeFindAvPrecision } from '../find-av-precision.js'

describe('computeFindAvPrecision', () => {
  it('全件生存した場合、survivalRateは1', () => {
    const dedupedFindings = [
      { title: 'a', lens: 'logic', severity: 'important' },
      { title: 'b', lens: 'security', severity: 'critical' },
    ]
    const toVerify = dedupedFindings
    const verdicts = [{ refuted: false }, { refuted: false }]
    const result = computeFindAvPrecision(dedupedFindings, toVerify, verdicts, [])

    expect(result.findCount).toBe(2)
    expect(result.verifiedCount).toBe(2)
    expect(result.survivedCount).toBe(2)
    expect(result.survivalRate).toBe(1)
  })

  it('全件棄却された場合、survivalRateは0', () => {
    const dedupedFindings = [{ title: 'a', lens: 'logic', severity: 'important' }]
    const verdicts = [{ refuted: true }]
    const result = computeFindAvPrecision(dedupedFindings, dedupedFindings, verdicts, [])

    expect(result.survivedCount).toBe(0)
    expect(result.survivalRate).toBe(0)
  })

  it('minor指摘はverifiedCountに含めず、autoSurvivedMinorCountとしてsurvivedCountには加算する', () => {
    const dedupedFindings = [
      { title: 'a', lens: 'logic', severity: 'important' },
      { title: 'b', lens: 'ux', severity: 'minor' },
    ]
    const toVerify = [dedupedFindings[0]]
    const autoSurvivedMinor = [dedupedFindings[1]]
    const verdicts = [{ refuted: false }]
    const result = computeFindAvPrecision(dedupedFindings, toVerify, verdicts, autoSurvivedMinor)

    expect(result.findCount).toBe(2)
    expect(result.verifiedCount).toBe(1)
    expect(result.autoSurvivedMinorCount).toBe(1)
    expect(result.survivedCount).toBe(2) // 生存1件 + minor自動生存1件
    expect(result.survivalRate).toBe(1) // minorはverifiedCount側の分母に含めない
  })

  it('lens別の内訳(byLens)を正しく集計する', () => {
    const dedupedFindings = [
      { title: 'a', lens: 'logic', severity: 'important' },
      { title: 'b', lens: 'logic', severity: 'important' },
      { title: 'c', lens: 'security', severity: 'critical' },
    ]
    const verdicts = [{ refuted: false }, { refuted: true }, { refuted: false }]
    const result = computeFindAvPrecision(dedupedFindings, dedupedFindings, verdicts, [])

    expect(result.byLens.logic).toEqual({ verified: 2, survived: 1 })
    expect(result.byLens.security).toEqual({ verified: 1, survived: 1 })
  })

  it('lensが無い指摘はunknownとして集計する', () => {
    const dedupedFindings = [{ title: 'a', severity: 'important' }]
    const verdicts = [{ refuted: false }]
    const result = computeFindAvPrecision(dedupedFindings, dedupedFindings, verdicts, [])

    expect(result.byLens.unknown).toEqual({ verified: 1, survived: 1 })
  })

  it('検証対象が0件ならsurvivalRateはnull（0除算を避ける）', () => {
    const result = computeFindAvPrecision([], [], [], [])

    expect(result.verifiedCount).toBe(0)
    expect(result.survivalRate).toBeNull()
  })

  it('verdictがnull/undefinedの指摘は生存扱い（元のaidd-1-1-deep-task.jsのsurvivedFromVerify算出と同一挙動）', () => {
    const dedupedFindings = [{ title: 'a', lens: 'logic', severity: 'important' }]
    const result = computeFindAvPrecision(dedupedFindings, dedupedFindings, [null], [])

    expect(result.survivedCount).toBe(1)
  })
})
