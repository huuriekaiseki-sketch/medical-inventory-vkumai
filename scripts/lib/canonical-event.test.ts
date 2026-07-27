import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEventId, extractAgentType, KNOWN_AGENT_TYPES, subagentSkeletonAdapter, agentProgressAdapter, loopObservabilityAdapter, journalAdapter, loadAllEvents, correlateEvents } from './canonical-event'
import type { CanonicalEvent } from './canonical-event'

describe('KNOWN_AGENT_TYPES', () => {
  it('12種類のagentTypeを含む', () => {
    expect(KNOWN_AGENT_TYPES).toHaveLength(12)
    expect(KNOWN_AGENT_TYPES).toContain('sweep-ui')
    expect(KNOWN_AGENT_TYPES).toContain('implementer')
  })
})

describe('extractAgentType', () => {
  it('agentType単体の完全一致を認識する', () => {
    expect(extractAgentType('reviewer')).toBe('reviewer')
  })

  it('役割サフィックス付き(reviewer-correctness)からagentTypeを復元する', () => {
    expect(extractAgentType('reviewer-correctness')).toBe('reviewer')
  })

  it('既知agentTypeに前方一致しない場合はnullを返す', () => {
    expect(extractAgentType('unknown-agent')).toBeNull()
  })

  it('sweep-uiとsweep-dataのように前方一致が紛らわしい場合でも正しく判定する', () => {
    expect(extractAgentType('sweep-data-something')).toBe('sweep-data')
  })
})

describe('buildEventId', () => {
  it('source:agentType:timestamp:lineIndexの形式で組み立てる', () => {
    expect(buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 0)).toBe(
      'agent-progress:implementer:2026-07-27T00:00:00Z:0',
    )
  })

  it('agentTypeがnullの場合はunknownを使う', () => {
    expect(buildEventId('subagent-skeleton', null, '2026-07-27T00:00:00Z', 3)).toBe(
      'subagent-skeleton:unknown:2026-07-27T00:00:00Z:3',
    )
  })

  it('同一秒・同一agentTypeでもlineIndexが異なれば衝突しない', () => {
    const a = buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 0)
    const b = buildEventId('agent-progress', 'implementer', '2026-07-27T00:00:00Z', 1)
    expect(a).not.toBe(b)
  })
})

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('subagentSkeletonAdapter', () => {
  it('Start行はstartTimestamp、Stop行はendTimestampに割り当てる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeleton-test-'))
    const logFile = join(dir, 'subagent-skeleton.jsonl')
    writeFileSync(
      logFile,
      [
        line({ timestamp: '2026-07-27T00:00:00Z', hookEvent: 'SubagentStart', agentId: 'a1', agentType: 'workflow-subagent' }),
        line({
          timestamp: '2026-07-27T00:00:02Z',
          hookEvent: 'SubagentStop',
          agentId: 'a1',
          agentType: 'workflow-subagent',
          lastAssistantMessage: 'ok',
        }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const events = subagentSkeletonAdapter(logFile).load()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ agentId: 'a1', startTimestamp: '2026-07-27T00:00:00Z', endTimestamp: null, source: 'subagent-skeleton' })
    expect(events[1]).toMatchObject({ agentId: 'a1', startTimestamp: null, endTimestamp: '2026-07-27T00:00:02Z', detail: 'ok' })
  })

  it('ファイルが存在しない場合は空配列を返す', () => {
    const events = subagentSkeletonAdapter('/tmp/does-not-exist-xyz.jsonl').load()
    expect(events).toEqual([])
  })

  it('必須フィールド欠落の行（例: agentId欠落）はスキップされる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeleton-test-invalid-'))
    const logFile = join(dir, 'subagent-skeleton-invalid.jsonl')
    writeFileSync(
      logFile,
      [
        line({ timestamp: '2026-07-27T00:00:00Z', hookEvent: 'SubagentStart', agentId: 'valid-a1' }),
        // agentIdが欠落した無効な行
        line({ timestamp: '2026-07-27T00:00:01Z', hookEvent: 'SubagentStop' }),
        line({ timestamp: '2026-07-27T00:00:02Z', hookEvent: 'SubagentStop', agentId: 'valid-a2' }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const events = subagentSkeletonAdapter(logFile).load()
    // 最初と3番目の行だけが有効で、2番目はスキップされる
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ agentId: 'valid-a1' })
    expect(events[1]).toMatchObject({ agentId: 'valid-a2' })
  })
})

describe('agentProgressAdapter', () => {
  it('全ステータス(starting/running/waiting/done/failed)を落とさずに出力する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-progress-test-'))
    const logFile = join(dir, 'agent-progress.jsonl')
    writeFileSync(
      logFile,
      [
        line({ timestamp: '2026-07-27T00:00:00Z', agent: 'implementer', feature: 'f1', status: 'starting', note: 'n1' }),
        line({ timestamp: '2026-07-27T00:01:00Z', agent: 'implementer', feature: 'f1', status: 'running', note: 'n2' }),
        line({ timestamp: '2026-07-27T00:02:00Z', agent: 'implementer', feature: 'f1', status: 'done', note: 'n3' }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const events = agentProgressAdapter(logFile).load()
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.status)).toEqual(['starting', 'running', 'done'])
    expect(events[0].agentType).toBe('implementer')
    expect(events[2]).toMatchObject({ feature: 'f1', endTimestamp: '2026-07-27T00:02:00Z', detail: 'n3', agentId: null, source: 'agent-progress' })
  })

  it('役割サフィックス付きagent(reviewer-correctness)からagentTypeを復元する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-progress-test-suffix-'))
    const logFile = join(dir, 'agent-progress.jsonl')
    writeFileSync(logFile, line({ timestamp: '2026-07-27T00:00:00Z', agent: 'reviewer-correctness', feature: 'f1', status: 'done', note: 'n' }) + '\n', 'utf-8')

    const events = agentProgressAdapter(logFile).load()
    expect(events[0].agentType).toBe('reviewer')
  })
})

describe('loopObservabilityAdapter', () => {
  it('1行=1イベントとして正規化する(result->status, reason->detail)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-obs-test-'))
    const logFile = join(dir, 'loop-observability.jsonl')
    writeFileSync(
      logFile,
      line({
        timestamp: '2026-07-27T00:00:00Z',
        agent: 'implementer',
        feature: 'f1',
        intent: 'テスト実装',
        scenario: '正常系',
        result: 'pass',
        reason: '全テスト成功',
      }) + '\n',
      'utf-8',
    )

    const events = loopObservabilityAdapter(logFile).load()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      agentType: 'implementer',
      feature: 'f1',
      endTimestamp: '2026-07-27T00:00:00Z',
      status: 'pass',
      detail: '全テスト成功',
      intent: 'テスト実装',
      scenario: '正常系',
      agentId: null,
      source: 'loop-observability',
    })
  })
})

describe('loadAllEvents', () => {
  it('指定した4ソース全てのイベントを結合する（全ソース同時指定）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-all-test-all-sources-'))
    const subagentSkeletonLogFile = join(dir, 'subagent-skeleton.jsonl')
    const agentProgressLogFile = join(dir, 'agent-progress.jsonl')
    const loopObservabilityLogFile = join(dir, 'loop-observability.jsonl')

    // subagent-skeleton: Start/Stop各1行
    writeFileSync(
      subagentSkeletonLogFile,
      [
        line({ timestamp: '2026-07-27T00:00:00Z', hookEvent: 'SubagentStart', agentId: 'a1', agentType: 'workflow-subagent' }),
        line({ timestamp: '2026-07-27T00:00:01Z', hookEvent: 'SubagentStop', agentId: 'a1', agentType: 'workflow-subagent' }),
      ].join('\n') + '\n',
      'utf-8',
    )

    // agent-progress: 1行
    writeFileSync(agentProgressLogFile, line({ timestamp: '2026-07-27T00:00:02Z', agent: 'implementer', feature: 'f1', status: 'done', note: 'n' }) + '\n', 'utf-8')

    // loop-observability: 1行
    writeFileSync(loopObservabilityLogFile, line({ timestamp: '2026-07-27T00:00:03Z', agent: 'implementer', feature: 'f1', intent: 'i', scenario: 's', result: 'pass', reason: 'r' }) + '\n', 'utf-8')

    // journal: wf_*ディレクトリ配下にagent-*.jsonl+.meta.jsonのペア
    const projectDir = mkdtempSync(join(tmpdir(), 'journal-all-test-'))
    const wfDir = join(projectDir, 'wf_1')
    mkdirSync(wfDir)
    writeFileSync(
      join(wfDir, 'agent-j1.jsonl'),
      [
        line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-27T00:00:04.000Z' }),
        line({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5',
            content: [{ type: 'tool_use', name: 'StructuredOutput', input: { status: 'pass', detail: 'ok' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          timestamp: '2026-07-27T00:00:05.000Z',
        }),
      ].join('\n'),
      'utf-8',
    )
    writeFileSync(join(wfDir, 'agent-j1.meta.json'), JSON.stringify({ agentType: 'reviewer' }), 'utf-8')

    const events = loadAllEvents({ subagentSkeletonLogFile, agentProgressLogFile, loopObservabilityLogFile, projectDir })
    expect(events.length).toBeGreaterThanOrEqual(4)
    const sources = events.map((e) => e.source)
    expect(sources).toContain('subagent-skeleton')
    expect(sources).toContain('agent-progress')
    expect(sources).toContain('loop-observability')
    expect(sources).toContain('journal')
  })

  it('指定した2ソースのイベントをすべて結合する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'load-all-test-'))
    const agentProgressLogFile = join(dir, 'agent-progress.jsonl')
    const loopObservabilityLogFile = join(dir, 'loop-observability.jsonl')
    writeFileSync(agentProgressLogFile, line({ timestamp: '2026-07-27T00:00:00Z', agent: 'implementer', feature: 'f1', status: 'done', note: 'n' }) + '\n', 'utf-8')
    writeFileSync(loopObservabilityLogFile, line({ timestamp: '2026-07-27T00:00:01Z', agent: 'implementer', feature: 'f1', intent: 'i', scenario: 's', result: 'pass', reason: 'r' }) + '\n', 'utf-8')

    const events = loadAllEvents({ agentProgressLogFile, loopObservabilityLogFile })
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.source).sort()).toEqual(['agent-progress', 'loop-observability'])
  })

  it('パスを指定しなかったソースは含めない', () => {
    const events = loadAllEvents({})
    expect(events).toEqual([])
  })
})

describe('journalAdapter', () => {
  it('journal.jsonlの構造化resultがある場合はそちらのstatus/detailを優先する', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'journal-adapter-test-'))
    const wfDir = join(projectDir, 'wf_1')
    mkdirSync(wfDir)
    writeFileSync(
      join(wfDir, 'agent-a1.jsonl'),
      [
        line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-27T00:00:00.000Z' }),
        line({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5',
            content: [{ type: 'tool_use', name: 'StructuredOutput', input: { status: 'fail', detail: 'transcript側(上書きされるはず)' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          timestamp: '2026-07-27T00:00:01.000Z',
        }),
      ].join('\n'),
      'utf-8',
    )
    writeFileSync(join(wfDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')
    writeFileSync(
      join(wfDir, 'journal.jsonl'),
      [
        line({ type: 'started', key: 'v2:xxx', agentId: 'a1' }),
        line({ type: 'result', key: 'v2:xxx', agentId: 'a1', result: { status: 'pass', detail: 'journal側のdetail' } }),
      ].join('\n'),
      'utf-8',
    )

    const events = journalAdapter(projectDir).load()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      agentId: 'a1',
      agentType: 'implementer',
      status: 'pass',
      detail: 'journal側のdetail',
      endTimestamp: '2026-07-27T00:00:01.000Z',
      source: 'journal',
    })
  })

  it('複数のwf_*ディレクトリを横断して読む', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'journal-adapter-multi-test-'))
    for (const [wfName, agentId] of [['wf_1', 'a1'], ['wf_2', 'a2']] as const) {
      const wfDir = join(projectDir, wfName)
      mkdirSync(wfDir)
      writeFileSync(
        join(wfDir, `agent-${agentId}.jsonl`),
        line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-27T00:00:00.000Z' }),
        'utf-8',
      )
      writeFileSync(join(wfDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'reviewer' }), 'utf-8')
    }

    const events = journalAdapter(projectDir).load()
    expect(events).toHaveLength(2)
  })

  it('journal.jsonlが無い場合はtranscriptのStructuredOutput結果(status/detail)にフォールバックする', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'journal-adapter-fallback-test-'))
    const wfDir = join(projectDir, 'wf_1')
    mkdirSync(wfDir)
    writeFileSync(
      join(wfDir, 'agent-a1.jsonl'),
      [
        line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-27T00:00:00.000Z' }),
        line({
          type: 'assistant',
          message: {
            model: 'claude-sonnet-5',
            content: [{ type: 'tool_use', name: 'StructuredOutput', input: { status: 'pass', detail: 'transcript由来のdetail' } }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
          timestamp: '2026-07-27T00:00:01.000Z',
        }),
      ].join('\n'),
      'utf-8',
    )
    writeFileSync(join(wfDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')
    // journal.jsonlを意図的に作成しない(フォールバック経路を通す)

    const events = journalAdapter(projectDir).load()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      agentId: 'a1',
      agentType: 'implementer',
      status: 'pass',
      detail: 'transcript由来のdetail',
      endTimestamp: '2026-07-27T00:00:01.000Z',
      source: 'journal',
    })
  })
})

describe('correlateEvents (Stage 1: agentId厳密一致)', () => {
  it('同一agentIdを持つsubagent-skeletonとjournalのイベントを1つのCorrelatedExecutionにまとめる', () => {
    const events: CanonicalEvent[] = [
      { eventId: 'e1', agentId: 'a1', agentType: 'workflow-subagent', feature: null, startTimestamp: '2026-07-27T00:00:00Z', endTimestamp: null, status: null, detail: null, intent: null, scenario: null, source: 'subagent-skeleton' },
      { eventId: 'e2', agentId: 'a1', agentType: 'workflow-subagent', feature: null, startTimestamp: null, endTimestamp: '2026-07-27T00:00:02Z', status: null, detail: 'ok', intent: null, scenario: null, source: 'subagent-skeleton' },
      { eventId: 'e3', agentId: 'a1', agentType: 'implementer', feature: null, startTimestamp: null, endTimestamp: '2026-07-27T00:00:02.000Z', status: 'pass', detail: 'journal detail', intent: null, scenario: null, source: 'journal' },
    ]

    const result = correlateEvents(events)
    expect(result).toHaveLength(1)
    expect(result[0].agentId).toBe('a1')
    expect(result[0].events).toHaveLength(3)
  })

  it('agentIdが異なれば別々のCorrelatedExecutionになる', () => {
    const events: CanonicalEvent[] = [
      { eventId: 'e1', agentId: 'a1', agentType: 'implementer', feature: null, startTimestamp: null, endTimestamp: '2026-07-27T00:00:00Z', status: 'pass', detail: null, intent: null, scenario: null, source: 'journal' },
      { eventId: 'e2', agentId: 'a2', agentType: 'reviewer', feature: null, startTimestamp: null, endTimestamp: '2026-07-27T00:00:00Z', status: 'pass', detail: null, intent: null, scenario: null, source: 'journal' },
    ]

    const result = correlateEvents(events)
    expect(result).toHaveLength(2)
  })
})
