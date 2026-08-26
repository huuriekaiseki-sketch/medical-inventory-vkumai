import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { harvestJournalEvents, harvestKey, loadHarvestedEvents } from './harvest-journal-events'
import type { CanonicalEvent } from './canonical-event'

function journalEvent(overrides: Partial<CanonicalEvent>): CanonicalEvent {
  return {
    eventId: 'journal:implementer:2026-08-26T00:00:00Z:0',
    agentId: 'a1',
    agentType: 'implementer',
    feature: null,
    startTimestamp: null,
    endTimestamp: '2026-08-26T00:00:00Z',
    status: 'pass',
    detail: null,
    intent: null,
    scenario: null,
    source: 'journal',
    ...overrides,
  }
}

function sandboxFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'harvest-test-')), 'journal-harvest.jsonl')
}

describe('harvestKey', () => {
  it('source+agentIdから安定キーを組み立てる(eventIdのlineIndexに依存しない)', () => {
    const a = journalEvent({ eventId: 'journal:implementer:t:0' })
    const b = journalEvent({ eventId: 'journal:implementer:t:99' })
    expect(harvestKey(a)).toBe(harvestKey(b))
  })
})

describe('loadHarvestedEvents', () => {
  it('ファイルが無ければ空配列を返す', () => {
    expect(loadHarvestedEvents(sandboxFile())).toEqual([])
  })

  it('JSONLを読み込み、壊れた行は無言でスキップする', () => {
    const file = sandboxFile()
    writeFileSync(file, `${JSON.stringify(journalEvent({}))}\nnot-json\n`)
    const events = loadHarvestedEvents(file)
    expect(events).toHaveLength(1)
    expect(events[0].agentId).toBe('a1')
  })
})

describe('harvestJournalEvents', () => {
  it('初回は全イベントを追記する', () => {
    const file = sandboxFile()
    const fresh = [journalEvent({ agentId: 'a1' }), journalEvent({ agentId: 'a2' })]
    const result = harvestJournalEvents('/unused', file, () => fresh)
    expect(result.appended).toBe(2)
    expect(loadHarvestedEvents(file)).toHaveLength(2)
  })

  it('同じagentIdのイベントは二重に追記しない(eventIdが変わっていても)', () => {
    const file = sandboxFile()
    harvestJournalEvents('/unused', file, () => [journalEvent({ agentId: 'a1', eventId: 'journal:implementer:t:0' })])
    // wf_*ディレクトリの増減でlineIndexがズレ、同一イベントのeventIdが変わったケースを再現
    const result = harvestJournalEvents('/unused', file, () => [
      journalEvent({ agentId: 'a1', eventId: 'journal:implementer:t:42' }),
      journalEvent({ agentId: 'a3' }),
    ])
    expect(result.appended).toBe(1)
    const harvested = loadHarvestedEvents(file)
    expect(harvested.map((e) => e.agentId).sort()).toEqual(['a1', 'a3'])
  })

  it('agentIdがnullのイベントは安定キーを作れないため追記せずskippedに数える', () => {
    const file = sandboxFile()
    const result = harvestJournalEvents('/unused', file, () => [journalEvent({ agentId: null })])
    expect(result.appended).toBe(0)
    expect(result.skipped).toBe(1)
    expect(loadHarvestedEvents(file)).toEqual([])
  })

  it('出力ファイルの親ディレクトリが無ければ作成する', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harvest-test-'))
    const file = join(dir, 'nested', 'journal-harvest.jsonl')
    const result = harvestJournalEvents('/unused', file, () => [journalEvent({})])
    expect(result.appended).toBe(1)
    expect(readFileSync(file, 'utf-8')).toContain('"agentId":"a1"')
  })
})
