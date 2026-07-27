import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentProgressAdapter, journalAdapter, loopObservabilityAdapter, subagentSkeletonAdapter } from './canonical-event'

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('loop-observability: 既存check-loop-observability-gap.sh(wc -l)との等価性', () => {
  it('Adapter出力件数が生ファイルの行数と一致する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'loop-obs-equiv-'))
    const logFile = join(dir, 'loop-observability.jsonl')
    const rawLines = [
      line({ timestamp: '2026-07-27T00:00:00Z', agent: 'implementer', feature: 'f1', intent: 'i', scenario: 's', result: 'pass', reason: 'r' }),
      line({ timestamp: '2026-07-27T00:01:00Z', agent: 'reviewer', feature: 'f1', intent: 'i', scenario: 's', result: 'fail', reason: 'r' }),
      line({ timestamp: '2026-07-27T00:02:00Z', agent: 'implementer', feature: 'f1', intent: 'i', scenario: 's', result: 'pass', reason: 'r' }),
    ]
    writeFileSync(logFile, rawLines.join('\n') + '\n', 'utf-8')

    const events = loopObservabilityAdapter(logFile).load()
    expect(events).toHaveLength(rawLines.length) // = check-loop-observability-gap.shの`wc -l`相当
  })
})

describe('agent-progress: 既存check-agent-progress-gap.shとの等価性', () => {
  const rawRecords = [
    { timestamp: '2026-07-27T00:00:00Z', agent: 'implementer', feature: 'f1', status: 'starting', note: 'n' },
    { timestamp: '2026-07-27T00:01:00Z', agent: 'implementer', feature: 'f1', status: 'running', note: 'n' },
    { timestamp: '2026-07-27T00:02:00Z', agent: 'implementer', feature: 'f1', status: 'done', note: 'n' },
    { timestamp: '2026-07-27T00:03:00Z', agent: 'reviewer', feature: 'f1', status: 'failed', note: 'n' },
  ]

  it('①fidelity: Adapter出力件数(全ステータス)が生ファイルの行数と一致する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-progress-equiv-fidelity-'))
    const logFile = join(dir, 'agent-progress.jsonl')
    writeFileSync(logFile, rawRecords.map(line).join('\n') + '\n', 'utf-8')

    const events = agentProgressAdapter(logFile).load()
    expect(events).toHaveLength(rawRecords.length)
  })

  it('②既存jqフィルタ(status=="done" or "failed")との等価性(gap check本体)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-progress-equiv-jq-'))
    const logFile = join(dir, 'agent-progress.jsonl')
    writeFileSync(logFile, rawRecords.map(line).join('\n') + '\n', 'utf-8')

    // check-agent-progress-gap.shの
    // `jq '[.[] | select(.status == "done" or .status == "failed")] | length'`をJSで再現した基準値
    const jqEquivalentCount = rawRecords.filter((r) => r.status === 'done' || r.status === 'failed').length
    expect(jqEquivalentCount).toBe(2)

    const events = agentProgressAdapter(logFile).load()
    const doneOrFailedCount = events.filter((e) => e.status === 'done' || e.status === 'failed').length
    expect(doneOrFailedCount).toBe(jqEquivalentCount)
  })
})

describe('journal/subagent-skeleton: 対応する既存gap checkが無いため、Adapter自体の正しさを既知件数fixtureで直接検証する', () => {
  it('journalAdapterはagent-*.jsonl/.meta.jsonのペア件数を正しく読む(既知件数=1)', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'journal-equiv-'))
    const wfDir = join(projectDir, 'wf_1')
    mkdirSync(wfDir)
    writeFileSync(
      join(wfDir, 'agent-a1.jsonl'),
      line({ type: 'user', message: { role: 'user', content: 'p' }, timestamp: '2026-07-27T00:00:00.000Z' }),
      'utf-8',
    )
    writeFileSync(join(wfDir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'implementer' }), 'utf-8')

    const events = journalAdapter(projectDir).load()
    expect(events).toHaveLength(1)
  })

  it('subagentSkeletonAdapterはStart+Stopの2行を正しく読む(既知件数=2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skeleton-equiv-'))
    const logFile = join(dir, 'subagent-skeleton.jsonl')
    writeFileSync(
      logFile,
      [
        line({ timestamp: '2026-07-27T00:00:00Z', hookEvent: 'SubagentStart', agentId: 'a1', agentType: 'workflow-subagent' }),
        line({ timestamp: '2026-07-27T00:00:02Z', hookEvent: 'SubagentStop', agentId: 'a1', agentType: 'workflow-subagent', lastAssistantMessage: 'ok' }),
      ].join('\n') + '\n',
      'utf-8',
    )

    const events = subagentSkeletonAdapter(logFile).load()
    expect(events).toHaveLength(2)
  })
})
