import { describe, it, expect } from 'vitest'
import { describeSweepResult, classifyPhase1Results } from '../phase1-result-classification.js'

describe('describeSweepResult', () => {
  it('null（agent()自体の実行失敗）は実行失敗の文言を返す', () => {
    expect(describeSweepResult(null)).toBe('(実行失敗: エージェントが結果を返しませんでした。手動で再実行してください)')
  })

  it('detailが「指摘なし」ならそのまま返す', () => {
    expect(describeSweepResult({ status: 'pass', detail: '指摘なし' })).toBe('指摘なし')
  })

  it('detailに指摘本文があればそのまま返す', () => {
    expect(describeSweepResult({ status: 'pass', detail: '型不整合が1件あります' })).toBe('型不整合が1件あります')
  })

  it('status:blocked（agent自身の自己申告）でもdetailをそのまま返す（実行失敗とは区別する）', () => {
    expect(describeSweepResult({ status: 'blocked', detail: '対象コードが存在しません' })).toBe('対象コードが存在しません')
  })
})

describe('classifyPhase1Results', () => {
  it('全結果がpassかつ指摘ありならfindingCountに計上される', () => {
    const results = [
      { status: 'pass', detail: 'UI指摘' },
      { status: 'pass', detail: '指摘なし' },
      { status: 'pass', detail: 'DB指摘' },
      { status: 'pass', detail: '指摘なし' },
    ]
    expect(classifyPhase1Results(results)).toEqual({ findingCount: 2, blockedCount: 0, failedCount: 0 })
  })

  it('status:blockedはblockedCountに計上され、findingCountには計上されない', () => {
    const results = [
      { status: 'blocked', detail: '対象コードなし' },
      { status: 'pass', detail: '指摘なし' },
    ]
    expect(classifyPhase1Results(results)).toEqual({ findingCount: 0, blockedCount: 1, failedCount: 0 })
  })

  it('issue #521: nullはfailedCountに計上され、blockedCount・findingCountのどちらにも計上されない', () => {
    const results = [null, { status: 'pass', detail: '指摘なし' }]
    expect(classifyPhase1Results(results)).toEqual({ findingCount: 0, blockedCount: 0, failedCount: 1 })
  })

  it('issue #521: 4体全滅(全てnull)でもfindingCount:0を装わずfailedCountで実態を表す', () => {
    const results = [null, null, null, null]
    expect(classifyPhase1Results(results)).toEqual({ findingCount: 0, blockedCount: 0, failedCount: 4 })
  })

  it('pass/blocked/failed/指摘ありが混在するケース', () => {
    const results = [
      { status: 'pass', detail: 'UI指摘' },
      { status: 'blocked', detail: '権限不足' },
      null,
      { status: 'pass', detail: '指摘なし' },
    ]
    expect(classifyPhase1Results(results)).toEqual({ findingCount: 1, blockedCount: 1, failedCount: 1 })
  })
})
