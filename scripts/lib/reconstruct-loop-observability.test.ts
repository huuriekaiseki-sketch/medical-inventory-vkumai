import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assignAttempts,
  buildLoopObservabilityEntry,
  deriveIntent,
  mapAgentTypeToLoop,
  pairAgentFiles,
  parseAgentTranscriptLines,
  parseJournalResults,
  reconstructWorkflowDir,
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

describe('parseJournalResults', () => {
  it('type:"result"かつstatusが既知の値の行をagentIdごとにMap化する', () => {
    const lines = [
      line({ type: 'started', key: 'v2:aaa', agentId: 'a1' }),
      line({ type: 'result', key: 'v2:aaa', agentId: 'a1', result: { status: 'pass', detail: '指摘なし' } }),
      line({
        type: 'result',
        key: 'v2:bbb',
        agentId: 'a2',
        result: { status: 'fail', detail: '実装漏れ', findings: [{ severity: 'critical', description: 'x' }] },
      }),
    ]
    const results = parseJournalResults(lines)
    expect(results.size).toBe(2)
    expect(results.get('a1')).toEqual({ status: 'pass', detail: '指摘なし', findings: null })
    expect(results.get('a2')).toEqual({
      status: 'fail',
      detail: '実装漏れ',
      findings: [{ severity: 'critical', description: 'x' }],
    })
  })

  it('resultがプレーンな文字列（statusを持たない）の行は無視する（実データで観測されたケース）', () => {
    const lines = [
      line({ type: 'result', key: 'v2:ccc', agentId: 'a3', result: 'af57a6077ca388dede819b409c55a1216b5eb329' }),
    ]
    expect(parseJournalResults(lines).size).toBe(0)
  })

  it('statusが既知の値（pass/fail/blocked）以外の行は無視する', () => {
    const lines = [line({ type: 'result', key: 'v2:ddd', agentId: 'a4', result: { status: 'unknown-status' } })]
    expect(parseJournalResults(lines).size).toBe(0)
  })

  it('type:"started"の行は無視する', () => {
    const lines = [line({ type: 'started', key: 'v2:eee', agentId: 'a5' })]
    expect(parseJournalResults(lines).size).toBe(0)
  })

  it('JSONとしてパースできない行は無視する', () => {
    expect(() => parseJournalResults(['not json'])).not.toThrow()
    expect(parseJournalResults(['not json']).size).toBe(0)
  })

  it('同じagentIdの行が複数ある場合は最後の行を採用する', () => {
    const lines = [
      line({ type: 'result', key: 'v2:fff', agentId: 'a6', result: { status: 'fail', detail: '1回目' } }),
      line({ type: 'result', key: 'v2:ggg', agentId: 'a6', result: { status: 'pass', detail: '2回目' } }),
    ]
    expect(parseJournalResults(lines).get('a6')).toEqual({ status: 'pass', detail: '2回目', findings: null })
  })
})

describe('reconstructWorkflowDir', () => {
  function agentTranscriptLines(status: string, detail: string, timestamp: string): string {
    return [
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-11T03:00:00.000Z' }),
      line({
        type: 'assistant',
        message: {
          model: 'claude-sonnet-5',
          content: [{ type: 'tool_use', name: 'StructuredOutput', input: { status, detail } }],
          usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        },
        timestamp,
      }),
    ].join('\n')
  }

  it('journal.jsonlが存在し該当agentIdの構造化resultがある場合、そのstatus/detail/findingsを優先する（transcript側と異なる値で検証）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconstruct-journal-test-'))
    // transcript側はfailを記録しているが、journal.jsonl側はpassを記録している状況を作り、
    // journal.jsonl優先で復元されることを確認する
    writeFileSync(
      join(dir, 'agent-a1.jsonl'),
      agentTranscriptLines('fail', 'transcript側のdetail(古い/不整合を想定)', '2026-07-11T03:00:01.000Z'),
      'utf-8',
    )
    writeFileSync(join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')
    writeFileSync(
      join(dir, 'journal.jsonl'),
      [
        line({ type: 'started', key: 'v2:xxx', agentId: 'a1' }),
        line({ type: 'result', key: 'v2:xxx', agentId: 'a1', result: { status: 'pass', detail: 'journal側のdetail' } }),
      ].join('\n'),
      'utf-8',
    )

    const entries = reconstructWorkflowDir(dir, 'feature-x')
    expect(entries).toHaveLength(1)
    expect(entries[0].result).toBe('pass')
    expect(entries[0].reason).toBe('journal側のdetail')
    // model/tokensはjournal.jsonlに存在しないためtranscript側の値のまま復元されることを確認
    expect(entries[0].model).toBe('claude-sonnet-5')
    expect(entries[0].tokens).toBe(15)
  })

  it('journal.jsonlが存在しない場合、既存のtranscriptパース方式にフォールバックする（回帰確認）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconstruct-no-journal-test-'))
    writeFileSync(
      join(dir, 'agent-a2.jsonl'),
      agentTranscriptLines('blocked', 'transcriptのみのdetail', '2026-07-11T03:00:01.000Z'),
      'utf-8',
    )
    writeFileSync(join(dir, 'agent-a2.meta.json'), JSON.stringify({ agentType: 'reviewer' }), 'utf-8')

    const entries = reconstructWorkflowDir(dir, 'feature-y')
    expect(entries).toHaveLength(1)
    expect(entries[0].result).toBe('blocked')
    expect(entries[0].reason).toBe('transcriptのみのdetail')
  })

  it('journal.jsonlは存在するが該当agentIdの行が無い場合、そのagentはtranscriptパース方式にフォールバックする', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconstruct-journal-no-match-test-'))
    writeFileSync(
      join(dir, 'agent-a3.jsonl'),
      agentTranscriptLines('pass', 'transcript側フォールバックのdetail', '2026-07-11T03:00:01.000Z'),
      'utf-8',
    )
    writeFileSync(join(dir, 'agent-a3.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')
    // journal.jsonlはあるが、別のagentId(a-other)の行しか無い
    writeFileSync(
      join(dir, 'journal.jsonl'),
      line({ type: 'result', key: 'v2:yyy', agentId: 'a-other', result: { status: 'fail', detail: '別agent' } }),
      'utf-8',
    )

    const entries = reconstructWorkflowDir(dir, 'feature-z')
    expect(entries).toHaveLength(1)
    expect(entries[0].result).toBe('pass')
    expect(entries[0].reason).toBe('transcript側フォールバックのdetail')
  })

  it('journal.jsonlのresultがプレーンな文字列（statusを持たない）の場合、transcriptパース方式にフォールバックする', () => {
    const dir = mkdtempSync(join(tmpdir(), 'reconstruct-journal-plain-string-test-'))
    writeFileSync(
      join(dir, 'agent-a4.jsonl'),
      agentTranscriptLines('pass', 'transcript側フォールバック(文字列result)', '2026-07-11T03:00:01.000Z'),
      'utf-8',
    )
    writeFileSync(join(dir, 'agent-a4.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')
    writeFileSync(
      join(dir, 'journal.jsonl'),
      line({ type: 'result', key: 'v2:zzz', agentId: 'a4', result: 'af57a6077ca388dede819b409c55a1216b5eb329' }),
      'utf-8',
    )

    const entries = reconstructWorkflowDir(dir, 'feature-w')
    expect(entries).toHaveLength(1)
    expect(entries[0].result).toBe('pass')
    expect(entries[0].reason).toBe('transcript側フォールバック(文字列result)')
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
