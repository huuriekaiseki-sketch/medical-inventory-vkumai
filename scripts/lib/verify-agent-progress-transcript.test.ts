import { describe, expect, it } from 'vitest'
import { compareDetail, compareStatus, buildReport } from './verify-agent-progress-transcript'
import { correlateEvents, type CanonicalEvent } from './canonical-event'

describe('compareStatus', () => {
  it('自己申告doneとtranscript passは一致とみなす', () => {
    expect(compareStatus('done', 'pass')).toBe('match')
  })

  it('自己申告doneとtranscript blockedは一致とみなす（仕様確認待ち等の正常停止もあるため）', () => {
    expect(compareStatus('done', 'blocked')).toBe('match')
  })

  it('自己申告doneなのにtranscriptがfailなら食い違いとみなす', () => {
    expect(compareStatus('done', 'fail')).toBe('mismatch')
  })

  it('自己申告failedとtranscript failは一致とみなす', () => {
    expect(compareStatus('failed', 'fail')).toBe('match')
  })

  it('自己申告failedなのにtranscriptがpassなら食い違いとみなす', () => {
    expect(compareStatus('failed', 'pass')).toBe('mismatch')
  })

  it('transcript側にstatusが無ければunknownとする', () => {
    expect(compareStatus('done', null)).toBe('unknown')
  })
})

describe('compareDetail', () => {
  it('内容が近い場合はmatchとする', () => {
    expect(compareDetail('UI層調査完了。propsの型不整合を2件検出', 'UI層の調査が完了した。propsの型不整合を2件検出した')).toBe('match')
  })

  it('内容が無関係な場合はlow_overlapとする', () => {
    expect(compareDetail('実装完了', '別の話題について全く違う内容を書いています')).toBe('low_overlap')
  })

  it('どちらかが空文字の場合はunknownとする', () => {
    expect(compareDetail('', '実装完了')).toBe('unknown')
    expect(compareDetail('実装完了', null)).toBe('unknown')
  })
})

describe('buildReport', () => {
  it('食い違いをmismatchesに、低一致をlowOverlapDetailsに分類する', () => {
    const anchor1: CanonicalEvent = {
      eventId: 'j1', agentId: 'a1', agentType: 'sweep-ui', feature: null,
      startTimestamp: null, endTimestamp: '2026-07-15T03:00:10.000Z', status: 'fail',
      detail: 'propsの型不整合を検出、未修正のまま終了', intent: null, scenario: null, source: 'journal',
    }
    const self1: CanonicalEvent = {
      eventId: 's1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-15T03:00:12.000Z', status: 'done',
      detail: 'UI層調査完了', intent: null, scenario: null, source: 'agent-progress',
    }
    const anchor2: CanonicalEvent = {
      eventId: 'j2', agentId: 'a2', agentType: 'reviewer', feature: null,
      startTimestamp: null, endTimestamp: '2026-07-15T04:00:10.000Z', status: 'pass',
      detail: '無関係な全く別のセキュリティ観点の長い説明文をここに書く', intent: null, scenario: null, source: 'journal',
    }
    const self2: CanonicalEvent = {
      eventId: 's2', agentId: null, agentType: 'reviewer', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-15T04:00:12.000Z', status: 'done',
      detail: '完了', intent: null, scenario: null, source: 'agent-progress',
    }

    const correlated = correlateEvents([anchor1, self1, anchor2, self2])
    const report = buildReport(correlated)

    expect(report.matchedCount).toBe(2)
    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0].selfEvent.agentType).toBe('sweep-ui')
    expect(report.lowOverlapDetails.length).toBeGreaterThanOrEqual(1)
  })

  it('自己申告が0件なら空のレポートを返す', () => {
    const report = buildReport(correlateEvents([]))
    expect(report.totalSelfReports).toBe(0)
    expect(report.matchedCount).toBe(0)
    expect(report.mismatches).toHaveLength(0)
  })

  it('同一execにsubagent-skeleton(status:null)とjournal(status有り)が両方ある場合はjournal側を優先してanchorに使う', () => {
    const skeletonAnchor: CanonicalEvent = {
      eventId: 'sk1', agentId: 'a3', agentType: 'implementer', feature: null,
      startTimestamp: '2026-07-15T05:00:00.000Z', endTimestamp: null, status: null,
      detail: null, intent: null, scenario: null, source: 'subagent-skeleton',
    }
    const journalAnchor: CanonicalEvent = {
      eventId: 'j3', agentId: 'a3', agentType: 'implementer', feature: null,
      startTimestamp: null, endTimestamp: '2026-07-15T05:00:10.000Z', status: 'pass',
      detail: '実装完了', intent: null, scenario: null, source: 'journal',
    }
    const self3: CanonicalEvent = {
      eventId: 's3', agentId: null, agentType: 'implementer', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-15T05:00:12.000Z', status: 'done',
      detail: '実装完了', intent: null, scenario: null, source: 'agent-progress',
    }

    // loadAllEventsの呼び出し順(subagentSkeletonAdapter→...→journalAdapter)を再現するため、
    // subagent-skeletonをjournalより先の順序で渡す。
    const correlated = correlateEvents([skeletonAnchor, journalAnchor, self3])
    const report = buildReport(correlated)

    expect(report.unmatchedSelf).toHaveLength(0)
    expect(report.matchedCount).toBe(1)
    expect(report.mismatches).toHaveLength(0)
  })

  it('running/waiting/startingの中間状態はtotalSelfReportsに含めない', () => {
    const self: CanonicalEvent = {
      eventId: 's1', agentId: null, agentType: 'implementer', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-15T03:00:12.000Z', status: 'running',
      detail: '実行中', intent: null, scenario: null, source: 'agent-progress',
    }
    const report = buildReport(correlateEvents([self]))
    expect(report.totalSelfReports).toBe(0)
  })
})
