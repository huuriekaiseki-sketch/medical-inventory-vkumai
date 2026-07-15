import { describe, expect, it } from 'vitest'
import {
  buildReport,
  compareDetail,
  compareStatus,
  extractAgentType,
  matchRecords,
  type SelfReportRecord,
  type TranscriptRecord,
} from './verify-agent-progress-transcript'

describe('extractAgentType', () => {
  it('agentType単体の完全一致を認識する', () => {
    expect(extractAgentType('reviewer')).toBe('reviewer')
  })

  it('役割サフィックス付き(reviewer-correctness)からagentTypeを復元する', () => {
    expect(extractAgentType('reviewer-correctness')).toBe('reviewer')
  })

  it('implementer-groupAのようなグループ名サフィックスも復元する', () => {
    expect(extractAgentType('implementer-groupA')).toBe('implementer')
  })

  it('既知agentTypeに前方一致しない場合はnullを返す', () => {
    expect(extractAgentType('unknown-agent')).toBeNull()
  })

  it('sweep-uiとsweep-dataのように前方一致が紛らわしい場合でも正しく判定する', () => {
    expect(extractAgentType('sweep-ui')).toBe('sweep-ui')
    expect(extractAgentType('sweep-data-something')).toBe('sweep-data')
  })
})

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
    expect(compareDetail('UI層調査完了。propsの型不整合を2件検出', 'UI層の調査が完了した。propsの型不整合を2件検出した')).toBe(
      'match',
    )
  })

  it('内容が無関係な場合はlow_overlapとする', () => {
    expect(compareDetail('実装完了', '別の話題について全く違う内容を書いています')).toBe('low_overlap')
  })

  it('どちらかが空文字の場合はunknownとする', () => {
    expect(compareDetail('', '実装完了')).toBe('unknown')
    expect(compareDetail('実装完了', null)).toBe('unknown')
  })
})

describe('matchRecords', () => {
  const baseTranscript: TranscriptRecord = {
    wfDir: '/tmp/wf_1',
    agentId: 'a1',
    agentType: 'sweep-ui',
    endTimestamp: '2026-07-15T03:00:10.000Z',
    status: 'pass',
    detail: 'UI層調査完了',
  }

  const baseSelf: SelfReportRecord = {
    timestamp: '2026-07-15T03:00:12.000Z',
    agent: 'sweep-ui',
    feature: 'news-feed',
    status: 'done',
    note: 'UI層調査完了',
  }

  it('同一agentTypeで最も時刻が近いtranscriptと対応付ける', () => {
    const { matched, unmatchedSelf } = matchRecords([baseSelf], [baseTranscript])
    expect(matched).toHaveLength(1)
    expect(matched[0].transcript.agentId).toBe('a1')
    expect(unmatchedSelf).toHaveLength(0)
  })

  it('許容誤差を超えるtranscriptとは対応付けない', () => {
    const farTranscript = { ...baseTranscript, endTimestamp: '2026-07-15T05:00:00.000Z' }
    const { matched, unmatchedSelf } = matchRecords([baseSelf], [farTranscript], 60_000)
    expect(matched).toHaveLength(0)
    expect(unmatchedSelf).toHaveLength(1)
  })

  it('agentTypeが異なるtranscriptとは対応付けない', () => {
    const otherType = { ...baseTranscript, agentType: 'reviewer' }
    const { matched, unmatchedSelf } = matchRecords([baseSelf], [otherType])
    expect(matched).toHaveLength(0)
    expect(unmatchedSelf).toHaveLength(1)
  })

  it('同一agentTypeが複数ある場合、それぞれ最も近いtranscriptに1件ずつ割り当てる（使い回さない）', () => {
    const self2: SelfReportRecord = { ...baseSelf, timestamp: '2026-07-15T03:10:12.000Z' }
    const transcript2: TranscriptRecord = { ...baseTranscript, agentId: 'a2', endTimestamp: '2026-07-15T03:10:10.000Z' }
    const { matched } = matchRecords([baseSelf, self2], [baseTranscript, transcript2])
    expect(matched).toHaveLength(2)
    const assignedIds = matched.map((m) => m.transcript.agentId).sort()
    expect(assignedIds).toEqual(['a1', 'a2'])
  })

  it('既知agentTypeに復元できないagent名は未突合とする', () => {
    const weirdSelf = { ...baseSelf, agent: 'totally-unknown-agent' }
    const { matched, unmatchedSelf } = matchRecords([weirdSelf], [baseTranscript])
    expect(matched).toHaveLength(0)
    expect(unmatchedSelf).toHaveLength(1)
  })
})

describe('buildReport', () => {
  it('食い違いをmismatchesに、低一致をlowOverlapDetailsに分類する', () => {
    const selfReports: SelfReportRecord[] = [
      { timestamp: '2026-07-15T03:00:12.000Z', agent: 'sweep-ui', feature: 'f1', status: 'done', note: 'UI層調査完了' },
      { timestamp: '2026-07-15T04:00:12.000Z', agent: 'reviewer-security', feature: 'f1', status: 'done', note: '完了' },
    ]
    const transcripts: TranscriptRecord[] = [
      {
        wfDir: '/tmp/wf_1',
        agentId: 'a1',
        agentType: 'sweep-ui',
        endTimestamp: '2026-07-15T03:00:10.000Z',
        status: 'fail',
        detail: 'propsの型不整合を検出、未修正のまま終了',
      },
      {
        wfDir: '/tmp/wf_2',
        agentId: 'a2',
        agentType: 'reviewer',
        endTimestamp: '2026-07-15T04:00:10.000Z',
        status: 'pass',
        detail: '無関係な全く別のセキュリティ観点の長い説明文をここに書く',
      },
    ]

    const report = buildReport(selfReports, transcripts)
    expect(report.matchedCount).toBe(2)
    expect(report.mismatches).toHaveLength(1)
    expect(report.mismatches[0].self.agent).toBe('sweep-ui')
    expect(report.lowOverlapDetails.length).toBeGreaterThanOrEqual(1)
  })

  it('自己申告が0件なら空のレポートを返す', () => {
    const report = buildReport([], [])
    expect(report.totalSelfReports).toBe(0)
    expect(report.matchedCount).toBe(0)
    expect(report.mismatches).toHaveLength(0)
  })
})
