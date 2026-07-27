import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildEventId, extractAgentType, KNOWN_AGENT_TYPES, subagentSkeletonAdapter, agentProgressAdapter } from './canonical-event'

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
