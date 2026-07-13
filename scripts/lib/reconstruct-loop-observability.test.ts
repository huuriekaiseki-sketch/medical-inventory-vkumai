import { describe, expect, it } from 'vitest'
import {
  assignAttempts,
  buildLoopObservabilityEntry,
  deriveIntent,
  mapAgentTypeToLoop,
  pairAgentFiles,
  parseAgentTranscriptLines,
} from './reconstruct-loop-observability'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('parseAgentTranscriptLines', () => {
  it('最初のuserメッセージをpromptTextとstartTimestampとして抽出する', () => {
    const lines = [
      line({
        type: 'user',
        message: { role: 'user', content: 'SPEC.mdを読んで実装してください。' },
        timestamp: '2026-07-11T03:37:47.236Z',
      }),
    ]
    const summary = parseAgentTranscriptLines(lines)
    expect(summary.promptText).toBe('SPEC.mdを読んで実装してください。')
    expect(summary.startTimestamp).toBe('2026-07-11T03:37:47.236Z')
  })

  it('assistantメッセージのmodelとusageを集計する（tokensはinput+outputのみ）', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' }),
      line({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 5 },
        },
        timestamp: '2026-07-11T03:00:01.000Z',
      }),
      line({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: 'ok2' }],
          usage: { input_tokens: 20, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp: '2026-07-11T03:00:02.000Z',
      }),
    ]
    const summary = parseAgentTranscriptLines(lines)
    expect(summary.model).toBe('claude-sonnet-5')
    expect(summary.tokens).toBe(180) // (100+50) + (20+10)
    expect(summary.costUsd).not.toBeNull()
  })

  it('末尾のStructuredOutput tool_useからstatus/detailとendTimestampを抽出する', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' }),
      line({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [
            {
              type: 'tool_use',
              name: 'StructuredOutput',
              input: { status: 'pass', detail: '実装完了' },
            },
          ],
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp: '2026-07-11T03:39:23.648Z',
      }),
    ]
    const summary = parseAgentTranscriptLines(lines)
    expect(summary.status).toBe('pass')
    expect(summary.detail).toBe('実装完了')
    expect(summary.endTimestamp).toBe('2026-07-11T03:39:23.648Z')
  })

  it('StructuredOutputが無い場合はstatus/detailがnullで最後の行のtimestampをendTimestampにする', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' }),
      line({
        type: 'assistant',
        message: { model: 'claude-sonnet-5', content: [{ type: 'text', text: '途中' }] },
        timestamp: '2026-07-11T03:00:05.000Z',
      }),
    ]
    const summary = parseAgentTranscriptLines(lines)
    expect(summary.status).toBeNull()
    expect(summary.detail).toBeNull()
    expect(summary.endTimestamp).toBe('2026-07-11T03:00:05.000Z')
  })

  it('JSONとしてパースできない行は無視する', () => {
    const lines = ['not json', line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' })]
    expect(() => parseAgentTranscriptLines(lines)).not.toThrow()
  })

  it('未知モデルが混在する場合、costUsdはnullを返す（誤ったコストを出さない）', () => {
    const lines = [
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' }),
      line({
        type: 'assistant',
        message: {
          model: 'unknown-model-xyz',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp: '2026-07-11T03:00:01.000Z',
      }),
    ]
    const summary = parseAgentTranscriptLines(lines)
    expect(summary.costUsd).toBeNull()
  })
})

describe('mapAgentTypeToLoop', () => {
  it('reviewerとjudge-panelはdeveloperループにマッピングする（明示的に--loop developerを使っているため）', () => {
    expect(mapAgentTypeToLoop('reviewer')).toBe('developer')
    expect(mapAgentTypeToLoop('judge-panel')).toBe('developer')
  })

  it('implementerを含むそれ以外はagenticループにマッピングする（スクリプトのデフォルト値のため）', () => {
    expect(mapAgentTypeToLoop('implementer')).toBe('agentic')
    expect(mapAgentTypeToLoop('contract-writer')).toBe('agentic')
  })
})

describe('assignAttempts', () => {
  it('同じagentTypeのレコードをstartTimestamp昇順で1から採番する', () => {
    const records = [
      { agentType: 'implementer', startTimestamp: '2026-07-11T03:10:00.000Z' },
      { agentType: 'implementer', startTimestamp: '2026-07-11T03:00:00.000Z' },
      { agentType: 'reviewer', startTimestamp: '2026-07-11T03:05:00.000Z' },
    ]
    const result = assignAttempts(records)
    const implementerAttempts = result.filter((r) => r.agentType === 'implementer').map((r) => r.attempt)
    expect(implementerAttempts.sort()).toEqual([1, 2])
    expect(result.find((r) => r.agentType === 'reviewer')?.attempt).toBe(1)
  })
})

describe('deriveIntent', () => {
  it('プロンプト冒頭の1文をintentとして抽出する', () => {
    expect(deriveIntent('まず SPEC.md を Read ツールで読んでください。\nPart 2をもとに実装してください。')).toBe(
      'まず SPEC.md を Read ツールで読んでください。',
    )
  })

  it('promptTextがnullの場合は固定文言を返す', () => {
    expect(deriveIntent(null)).toBe('(transcriptから復元: プロンプト不明)')
  })
})

describe('pairAgentFiles', () => {
  it('agent-<id>.jsonlとagent-<id>.meta.jsonをペアリングする', () => {
    const filenames = [
      'agent-a06545410e11c3354.jsonl',
      'agent-a06545410e11c3354.meta.json',
      'agent-af6b5162be4fe41d2.jsonl',
      'agent-af6b5162be4fe41d2.meta.json',
      'journal.jsonl',
    ]
    const pairs = pairAgentFiles(filenames)
    expect(pairs).toHaveLength(2)
    expect(pairs.map((p) => p.agentId).sort()).toEqual(['a06545410e11c3354', 'af6b5162be4fe41d2'])
  })

  it('meta.jsonが無いjsonlは無視する（journal.jsonl等）', () => {
    const pairs = pairAgentFiles(['journal.jsonl', 'agent-a1.jsonl'])
    expect(pairs).toHaveLength(0)
  })
})

describe('buildLoopObservabilityEntry', () => {
  it('スキーマに沿ったレコードを組み立て、reconstructed:trueを付与する', () => {
    const entry = buildLoopObservabilityEntry({
      agentType: 'implementer',
      feature: 'unknown',
      attempt: 1,
      summary: {
        model: 'claude-sonnet-5',
        startTimestamp: '2026-07-11T03:37:47.236Z',
        endTimestamp: '2026-07-11T03:39:23.648Z',
        tokens: 1234,
        costUsd: 0.05,
        status: 'pass',
        detail: '実装完了',
        findings: null,
        promptText: 'SPEC.mdを読んで実装してください。',
      },
    })
    expect(entry).toMatchObject({
      timestamp: '2026-07-11T03:39:23.648Z',
      loop: 'agentic',
      agent: 'implementer',
      feature: 'unknown',
      attempt: 1,
      model: 'claude-sonnet-5',
      tokens: 1234,
      costUsd: 0.05,
      result: 'pass',
      reason: '実装完了',
      intent: 'SPEC.mdを読んで実装してください。',
      reconstructed: true,
    })
  })

  it('endTimestampが無い場合はstartTimestampをtimestampとして使う', () => {
    const entry = buildLoopObservabilityEntry({
      agentType: 'reviewer',
      feature: 'unknown',
      attempt: 1,
      summary: {
        model: null,
        startTimestamp: '2026-07-11T03:00:00.000Z',
        endTimestamp: null,
        tokens: 0,
        costUsd: null,
        status: null,
        detail: null,
        findings: null,
        promptText: null,
      },
    })
    expect(entry.timestamp).toBe('2026-07-11T03:00:00.000Z')
    expect(entry.result).toBe('unknown')
  })
})
