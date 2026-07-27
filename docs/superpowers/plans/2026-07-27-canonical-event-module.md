# Canonical Event Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** hook/journal/agent-progress/loop-observabilityの4つのAIDD実行ログを正規化する読み取り専用Adapterモジュール`scripts/lib/canonical-event.ts`を新設し、既存の`verify-agent-progress-transcript.ts`をそのモジュール経由の薄いラッパーへリファクタする。

**Architecture:** 各ログを`CanonicalEvent`に正規化する4つのAdapter（`subagentSkeletonAdapter`/`agentProgressAdapter`/`loopObservabilityAdapter`/`journalAdapter`）と、それらを同一実行単位へ突合する`correlateEvents()`（Stage1: agentId厳密一致 → Stage2: agentType+30分窓の貪欲割当）を実装する。ログの書き込み側・既存gap check bashスクリプトは無改修。

**Tech Stack:** TypeScript, vitest, Node.js `fs`/`path`標準モジュール

**参照仕様書:** [`docs/superpowers/specs/2026-07-27-canonical-event-module-design.md`](../specs/2026-07-27-canonical-event-module-design.md)

## Global Constraints

- コード内コメントは日本語で書き、WHY（なぜその実装か）のみを書く。WHATは書かない（既存コードの規約に合わせる）
- 既存のexport済み関数・型（`reconstruct-loop-observability.ts`の`pairAgentFiles`/`loadJournalResults`/`parseAgentTranscriptLines`等）は変更せず再利用する
- `verify-agent-progress-transcript.ts`のexit codeロジックは無変更のまま維持する（CLI引数・出力フォーマットはTask 10で`selfEvent`/`anchorEvent`等の新フィールド名・新テキストへ変更する。唯一の外部消費者`scripts/verify-agent-progress-transcript.sh`は出力をパースせず素通しするため実害なしとユーザー承認済み、2026-07-27）
- 全テストは`npm test`（vitest run）で実行できること。`vitest.config.ts`の`exclude`に該当しないファイル配置にする
- gap check bashスクリプト（`check-loop-observability-gap.sh`/`check-agent-progress-gap.sh`）自体は変更しない

---

## File Structure

- Create: `scripts/lib/canonical-event.ts` — 4 Adapter + `CanonicalEvent`型 + `correlateEvents()`
- Create: `scripts/lib/canonical-event.test.ts` — Adapter単体・`correlateEvents()`のテスト
- Create: `scripts/lib/canonical-event-gap-check-equivalence.test.ts` — 既存gap checkとの等価性テスト
- Modify: `scripts/lib/verify-agent-progress-transcript.ts` — `canonical-event.ts`経由の薄いラッパーへリファクタ
- Modify: `scripts/lib/verify-agent-progress-transcript.test.ts` — 新しい`buildReport`シグネチャに合わせて再配置
- Modify: `docs/agents/observability-internals.md` — 統合の設計・実機検証結果を追記
- Modify: `docs/agents/common.md` — 「重要ファイルへのパス」表に1行追加

---

### Task 1: CanonicalEvent型・eventIdヘルパー・agentTypeユーティリティ

**Files:**
- Create: `scripts/lib/canonical-event.ts`
- Test: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Produces: `EventSource`, `EventStatus`, `CanonicalEvent`, `KNOWN_AGENT_TYPES`, `extractAgentType(selfAgentField: string): string | null`, `buildEventId(source: EventSource, agentType: string | null, timestamp: string, lineIndex: number): string`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts
import { describe, expect, it } from 'vitest'
import { buildEventId, extractAgentType, KNOWN_AGENT_TYPES } from './canonical-event'

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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`./canonical-event`が存在しないためimportエラー）

- [ ] **Step 3: 最小実装を書く**

```ts
// scripts/lib/canonical-event.ts
export type EventSource = 'subagent-skeleton' | 'journal' | 'agent-progress' | 'loop-observability'
export type EventStatus = 'pass' | 'fail' | 'blocked' | 'done' | 'failed' | 'running' | 'starting' | 'waiting'

export interface CanonicalEvent {
  eventId: string
  agentId: string | null
  agentType: string | null
  feature: string | null
  startTimestamp: string | null
  endTimestamp: string | null
  status: EventStatus | null
  detail: string | null
  intent: string | null
  scenario: string | null
  source: EventSource
}

// docs/agents/common.md「サブエージェント進捗の可視化（issue #18）」に列挙されている
// 進捗記録対象agentType一覧。verify-agent-progress-transcript.tsから本モジュールへ移設（issue #569）。
export const KNOWN_AGENT_TYPES = [
  'sweep-db',
  'sweep-ui',
  'sweep-types',
  'sweep-data',
  'implementer',
  'reviewer',
  'integrator',
  'judge-panel',
  'proposer',
  'adversarial-verify',
  'completeness-critic',
  'contract-writer',
] as const

// 自己申告jsonlの--agentは「reviewer-correctness」「implementer-groupA」のように
// agentTypeへ役割サフィックスを付けた自由記述のため、既知agentType一覧との前方一致
// （区切りは'-'または完全一致）で復元する。
export function extractAgentType(selfAgentField: string): string | null {
  const candidates = KNOWN_AGENT_TYPES.filter(
    (type) => selfAgentField === type || selfAgentField.startsWith(`${type}-`),
  )
  if (candidates.length === 0) return null
  return candidates.reduce((longest, current) => (current.length > longest.length ? current : longest))
}

// 各log-*.shは秒精度タイムスタンプ(date -u +"%Y-%m-%dT%H:%M:%SZ")しか書かないため、
// 同一秒内の複数状態遷移がタイムスタンプだけでは衝突しうる。ログ生成側は無改修という前提のため、
// ファイル内の出現順インデックス(lineIndex)をキーに含めて一意性を保証する。
export function buildEventId(
  source: EventSource,
  agentType: string | null,
  timestamp: string,
  lineIndex: number,
): string {
  return `${source}:${agentType ?? 'unknown'}:${timestamp}:${lineIndex}`
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにCanonicalEvent型とagentTypeユーティリティを追加(issue #569)"
```

---

### Task 2: subagentSkeletonAdapter

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent`, `buildEventId` (Task 1)
- Produces: `EventAdapter`, `subagentSkeletonAdapter(logFile: string): EventAdapter`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { subagentSkeletonAdapter } from './canonical-event'

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
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`subagentSkeletonAdapter`が未定義）

- [ ] **Step 3: 実装する**

```ts
// scripts/lib/canonical-event.ts に追記
import { readFileSync } from 'node:fs'

export interface EventAdapter {
  source: EventSource
  load(): CanonicalEvent[]
}

interface SkeletonLine {
  timestamp: string
  hookEvent: string
  agentId: string
  agentType?: string
  lastAssistantMessage?: string
  intent?: string
}

function parseSkeletonLine(raw: string): SkeletonLine | null {
  try {
    return JSON.parse(raw) as SkeletonLine
  } catch {
    return null
  }
}

export function subagentSkeletonAdapter(logFile: string): EventAdapter {
  return {
    source: 'subagent-skeleton',
    load(): CanonicalEvent[] {
      let content: string
      try {
        content = readFileSync(logFile, 'utf-8')
      } catch {
        return []
      }
      const lines = content.split('\n').filter(Boolean)
      const events: CanonicalEvent[] = []
      lines.forEach((raw, lineIndex) => {
        const parsed = parseSkeletonLine(raw)
        if (!parsed) return
        const isStart = parsed.hookEvent === 'SubagentStart'
        const agentType = parsed.agentType ?? null
        events.push({
          eventId: buildEventId('subagent-skeleton', agentType, parsed.timestamp, lineIndex),
          agentId: parsed.agentId,
          agentType,
          feature: null,
          startTimestamp: isStart ? parsed.timestamp : null,
          endTimestamp: isStart ? null : parsed.timestamp,
          status: null,
          detail: parsed.lastAssistantMessage ?? null,
          intent: parsed.intent ?? null,
          scenario: null,
          source: 'subagent-skeleton',
        })
      })
      return events
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにsubagentSkeletonAdapterを追加(issue #569)"
```

---

### Task 3: agentProgressAdapter（全ステータス）

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent`, `buildEventId`, `extractAgentType`, `EventAdapter` (Task 1-2)
- Produces: `loadAllAgentProgressRecords(logFile: string): AgentProgressLine[]`, `agentProgressAdapter(logFile: string): EventAdapter`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { agentProgressAdapter } from './canonical-event'

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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`agentProgressAdapter`が未定義）

- [ ] **Step 3: 実装する**

```ts
// scripts/lib/canonical-event.ts に追記
interface AgentProgressLine {
  timestamp: string
  agent: string
  feature: string
  status: string
  note: string
}

export function loadAllAgentProgressRecords(logFile: string): AgentProgressLine[] {
  let content: string
  try {
    content = readFileSync(logFile, 'utf-8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as AgentProgressLine)
}

export function agentProgressAdapter(logFile: string): EventAdapter {
  return {
    source: 'agent-progress',
    load(): CanonicalEvent[] {
      return loadAllAgentProgressRecords(logFile).map((record, lineIndex) => {
        const agentType = extractAgentType(record.agent)
        return {
          eventId: buildEventId('agent-progress', agentType, record.timestamp, lineIndex),
          agentId: null,
          agentType,
          feature: record.feature,
          startTimestamp: null,
          endTimestamp: record.timestamp,
          status: record.status as EventStatus,
          detail: record.note,
          intent: null,
          scenario: null,
          source: 'agent-progress',
        }
      })
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにagentProgressAdapterを追加(issue #569)"
```

---

### Task 4: loopObservabilityAdapter

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: 同上（Task 1-3）
- Produces: `loadAllLoopObservabilityRecords(logFile: string): LoopObservabilityLine[]`, `loopObservabilityAdapter(logFile: string): EventAdapter`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { loopObservabilityAdapter } from './canonical-event'

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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`loopObservabilityAdapter`が未定義）

- [ ] **Step 3: 実装する**

```ts
// scripts/lib/canonical-event.ts に追記
interface LoopObservabilityLine {
  timestamp: string
  agent: string
  feature: string
  intent: string
  scenario: string
  result: string
  reason: string
}

export function loadAllLoopObservabilityRecords(logFile: string): LoopObservabilityLine[] {
  let content: string
  try {
    content = readFileSync(logFile, 'utf-8')
  } catch {
    return []
  }
  return content
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as LoopObservabilityLine)
}

export function loopObservabilityAdapter(logFile: string): EventAdapter {
  return {
    source: 'loop-observability',
    load(): CanonicalEvent[] {
      return loadAllLoopObservabilityRecords(logFile).map((record, lineIndex) => {
        const agentType = extractAgentType(record.agent)
        return {
          eventId: buildEventId('loop-observability', agentType, record.timestamp, lineIndex),
          agentId: null,
          agentType,
          feature: record.feature,
          startTimestamp: null,
          endTimestamp: record.timestamp,
          status: record.result as EventStatus,
          detail: record.reason,
          intent: record.intent,
          scenario: record.scenario,
          source: 'loop-observability',
        }
      })
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにloopObservabilityAdapterを追加(issue #569)"
```

---

### Task 5: journalAdapter（既存loadTranscriptsロジックの再利用）

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: `pairAgentFiles`, `loadJournalResults`, `parseAgentTranscriptLines`（`./reconstruct-loop-observability`、無改修で再利用）、`CanonicalEvent`, `buildEventId`, `EventAdapter`
- Produces: `journalAdapter(projectDir: string): EventAdapter`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { mkdirSync } from 'node:fs'
import { journalAdapter } from './canonical-event'

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
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`journalAdapter`が未定義）

- [ ] **Step 3: 実装する**

```ts
// scripts/lib/canonical-event.ts に追記
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { loadJournalResults, pairAgentFiles, parseAgentTranscriptLines } from './reconstruct-loop-observability'

// 既存verify-agent-progress-transcript.tsのfindWorkflowDirsと同一ロジック。
// wf_*という名前のディレクトリを再帰的に探索する。
function findWorkflowDirs(projectDir: string): string[] {
  const results: string[] = []
  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry)
      let stat
      try {
        stat = statSync(fullPath)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      if (entry.startsWith('wf_')) {
        results.push(fullPath)
        continue
      }
      walk(fullPath)
    }
  }
  walk(projectDir)
  return results
}

export function journalAdapter(projectDir: string): EventAdapter {
  return {
    source: 'journal',
    load(): CanonicalEvent[] {
      const events: CanonicalEvent[] = []
      let lineIndex = 0
      for (const wfDir of findWorkflowDirs(projectDir)) {
        const filenames = readdirSync(wfDir)
        const pairs = pairAgentFiles(filenames)
        const journalResults = loadJournalResults(wfDir, filenames)
        for (const { agentId, jsonlFile, metaFile } of pairs) {
          let agentType = 'unknown'
          try {
            const meta = JSON.parse(readFileSync(join(wfDir, metaFile), 'utf-8')) as { agentType?: string }
            agentType = meta.agentType ?? 'unknown'
          } catch {
            continue
          }
          const lines = readFileSync(join(wfDir, jsonlFile), 'utf-8').split('\n').filter(Boolean)
          const summary = parseAgentTranscriptLines(lines)
          const journalResult = journalResults.get(agentId)
          const status = journalResult ? journalResult.status : summary.status
          const detail = journalResult ? journalResult.detail : summary.detail

          events.push({
            eventId: buildEventId('journal', agentType, summary.endTimestamp ?? 'unknown', lineIndex++),
            agentId,
            agentType,
            feature: null,
            startTimestamp: summary.startTimestamp,
            endTimestamp: summary.endTimestamp,
            status,
            detail,
            intent: null,
            scenario: null,
            source: 'journal',
          })
        }
      }
      return events
    },
  }
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにjournalAdapterを追加(issue #569)"
```

---

### Task 6: loadAllEvents()

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: 4つのAdapter (Task 2-5)
- Produces: `LoadAllEventsOptions`, `loadAllEvents(opts?: LoadAllEventsOptions): CanonicalEvent[]`

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { loadAllEvents } from './canonical-event'

describe('loadAllEvents', () => {
  it('指定した4ソースのイベントをすべて結合する', () => {
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`loadAllEvents`が未定義）

- [ ] **Step 3: 実装する**

```ts
// scripts/lib/canonical-event.ts に追記
export interface LoadAllEventsOptions {
  subagentSkeletonLogFile?: string
  agentProgressLogFile?: string
  loopObservabilityLogFile?: string
  projectDir?: string
}

export function loadAllEvents(opts: LoadAllEventsOptions = {}): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  if (opts.subagentSkeletonLogFile) events.push(...subagentSkeletonAdapter(opts.subagentSkeletonLogFile).load())
  if (opts.agentProgressLogFile) events.push(...agentProgressAdapter(opts.agentProgressLogFile).load())
  if (opts.loopObservabilityLogFile) events.push(...loopObservabilityAdapter(opts.loopObservabilityLogFile).load())
  if (opts.projectDir) events.push(...journalAdapter(opts.projectDir).load())
  return events
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: canonical-event.tsにloadAllEvents()を追加(issue #569)"
```

---

### Task 7: correlateEvents() Stage 1（agentId厳密一致）

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: `CanonicalEvent` (Task 1)
- Produces: `CorrelatedExecution`, `correlateEvents(events: CanonicalEvent[], toleranceMs?: number): CorrelatedExecution[]`（このタスクではStage 1のみ実装。Stage 2はTask 8）

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
import { correlateEvents } from './canonical-event'

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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（`correlateEvents`が未定義）

- [ ] **Step 3: 実装する（Stage 1のみ。自己申告イベントは全て単独扱いにする仮実装）**

```ts
// scripts/lib/canonical-event.ts に追記
export interface CorrelatedExecution {
  agentId: string
  events: CanonicalEvent[]
}

const DEFAULT_TOLERANCE_MS = 30 * 60 * 1000

export function correlateEvents(events: CanonicalEvent[], toleranceMs = DEFAULT_TOLERANCE_MS): CorrelatedExecution[] {
  // Stage 1: agentIdを持つイベント(subagent-skeleton/journal)を厳密一致でグループ化する。
  // 両者は同一agentId空間であることを実機検証済み(2026-07-27、docs/superpowers/specs/
  // 2026-07-27-canonical-event-module-design.md参照)。
  const executions = new Map<string, CorrelatedExecution>()
  const selfReportEvents: CanonicalEvent[] = []

  for (const event of events) {
    if (event.agentId !== null) {
      const existing = executions.get(event.agentId)
      if (existing) {
        existing.events.push(event)
      } else {
        executions.set(event.agentId, { agentId: event.agentId, events: [event] })
      }
    } else {
      selfReportEvents.push(event)
    }
  }

  // Stage 2は次のタスクで実装する。ここでは自己申告イベントを一旦すべて単独のCorrelatedExecutionにする。
  for (const event of selfReportEvents) {
    executions.set(event.eventId, { agentId: event.eventId, events: [event] })
  }

  return [...executions.values()]
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: correlateEvents()にStage1(agentId厳密一致)を実装(issue #569)"
```

---

### Task 8: correlateEvents() Stage 2（agentType+時刻窓フォールバック）

**Files:**
- Modify: `scripts/lib/canonical-event.ts`
- Modify: `scripts/lib/canonical-event.test.ts`

**Interfaces:**
- Consumes: Task 7の`correlateEvents`実装を置き換える
- Produces: `correlateEvents`は変わらないシグネチャのまま、Stage 2ロジックを追加

- [ ] **Step 1: 失敗するテストを書く**

```ts
// scripts/lib/canonical-event.test.ts に追記
describe('correlateEvents (Stage 2: agentType+時刻窓フォールバック)', () => {
  const anchor: CanonicalEvent = {
    eventId: 'anchor1', agentId: 'a1', agentType: 'sweep-ui', feature: null,
    startTimestamp: null, endTimestamp: '2026-07-27T00:00:10.000Z', status: 'pass', detail: 'anchor detail',
    intent: null, scenario: null, source: 'journal',
  }

  it('agentIdを持たないagent-progress(done)を同一agentType・時刻窓内のアンカーへ対応付ける', () => {
    const self: CanonicalEvent = {
      eventId: 'self1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T00:00:12.000Z', status: 'done', detail: 'self detail',
      intent: null, scenario: null, source: 'agent-progress',
    }

    const result = correlateEvents([anchor, self])
    expect(result).toHaveLength(1)
    expect(result[0].events).toHaveLength(2)
  })

  it('agent-progressのrunning/waiting/startingは常に単独になる(突合対象外)', () => {
    const self: CanonicalEvent = {
      eventId: 'self1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T00:00:12.000Z', status: 'running', detail: 'self detail',
      intent: null, scenario: null, source: 'agent-progress',
    }

    const result = correlateEvents([anchor, self])
    expect(result).toHaveLength(2)
    const selfExec = result.find((r) => r.agentId === 'self1')
    expect(selfExec?.events).toHaveLength(1)
  })

  it('許容誤差を超えるアンカーとは対応付けない', () => {
    const self: CanonicalEvent = {
      eventId: 'self1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T02:00:00.000Z', status: 'done', detail: 'd',
      intent: null, scenario: null, source: 'agent-progress',
    }

    const result = correlateEvents([anchor, self])
    expect(result).toHaveLength(2)
  })

  it('同じアンカーにagent-progressとloop-observabilityの両方が対応付いても競合しない', () => {
    const selfProgress: CanonicalEvent = {
      eventId: 'self1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T00:00:11.000Z', status: 'done', detail: 'd1',
      intent: null, scenario: null, source: 'agent-progress',
    }
    const selfLoop: CanonicalEvent = {
      eventId: 'self2', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T00:00:11.500Z', status: 'pass', detail: 'd2',
      intent: 'i', scenario: 's', source: 'loop-observability',
    }

    const result = correlateEvents([anchor, selfProgress, selfLoop])
    expect(result).toHaveLength(1)
    expect(result[0].events).toHaveLength(3)
  })

  it('同一agentTypeが複数ある場合、それぞれ最も近いアンカーに1件ずつ割り当てる(使い回さない)', () => {
    const anchor2: CanonicalEvent = { ...anchor, agentId: 'a2', endTimestamp: '2026-07-27T00:10:10.000Z' }
    const self1: CanonicalEvent = {
      eventId: 'self1', agentId: null, agentType: 'sweep-ui', feature: 'f1',
      startTimestamp: null, endTimestamp: '2026-07-27T00:00:12.000Z', status: 'done', detail: 'd',
      intent: null, scenario: null, source: 'agent-progress',
    }
    const self2: CanonicalEvent = { ...self1, eventId: 'self2', endTimestamp: '2026-07-27T00:10:12.000Z' }

    const result = correlateEvents([anchor, anchor2, self1, self2])
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.events.length === 2)).toBe(true)
    const assignedAgentIds = result.map((r) => r.agentId).sort()
    expect(assignedAgentIds).toEqual(['a1', 'a2'])
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: FAIL（Stage 2未実装のため、自己申告イベントが常に単独扱いになりテストの期待と食い違う）

- [ ] **Step 3: `correlateEvents`をStage 2対応に書き換える**

```ts
// scripts/lib/canonical-event.ts の correlateEvents を丸ごと置き換える
const TERMINAL_AGENT_PROGRESS_STATUSES = new Set(['done', 'failed'])

function toEpochMs(timestamp: string): number | null {
  const ms = Date.parse(timestamp)
  return Number.isNaN(ms) ? null : ms
}

// agent-progressの中間状態(starting/running/waiting)は突合対象にしない。
// 既存loadSelfReports(verify-agent-progress-transcript.ts)がdone/failedのみを検証対象として
// きたのを踏襲する意図的な仕様(docs/superpowers/specs/2026-07-27-canonical-event-module-design.md参照)。
function isMatchTarget(event: CanonicalEvent): boolean {
  if (event.source === 'agent-progress') return TERMINAL_AGENT_PROGRESS_STATUSES.has(event.status ?? '')
  return true
}

export function correlateEvents(events: CanonicalEvent[], toleranceMs = DEFAULT_TOLERANCE_MS): CorrelatedExecution[] {
  const executions = new Map<string, CorrelatedExecution>()
  const selfReportEvents: CanonicalEvent[] = []

  // Stage 1: agentIdを持つイベント(subagent-skeleton/journal)を厳密一致でグループ化する。
  for (const event of events) {
    if (event.agentId !== null) {
      const existing = executions.get(event.agentId)
      if (existing) {
        existing.events.push(event)
      } else {
        executions.set(event.agentId, { agentId: event.agentId, events: [event] })
      }
    } else {
      selfReportEvents.push(event)
    }
  }

  // アンカー(agentId確定済みグループ)のagentType/endTimestamp代表値を算出する。
  interface AnchorInfo {
    agentId: string
    agentType: string | null
    endTimestamp: string | null
  }
  const anchorInfos: AnchorInfo[] = [...executions.entries()].map(([agentId, exec]) => {
    const withEndTs = exec.events.find((e) => e.endTimestamp !== null)
    return {
      agentId,
      agentType: withEndTs?.agentType ?? exec.events[0]?.agentType ?? null,
      endTimestamp: withEndTs?.endTimestamp ?? null,
    }
  })

  // Stage 2: ソースごとに独立した排他プールで、agentType一致・時刻窓内の最近傍アンカーへ貪欲割当する。
  // 排他制御を「ソース×agentType」単位にスコープすることで、agent-progressとloop-observabilityの
  // 両方が同じアンカーに対応付くこと自体は許容する(別ソースなので競合しない)。
  const bySource = new Map<EventSource, CanonicalEvent[]>()
  for (const event of selfReportEvents) {
    if (!isMatchTarget(event)) continue
    const bucket = bySource.get(event.source) ?? []
    bucket.push(event)
    bySource.set(event.source, bucket)
  }

  const matchedEventIds = new Set<string>()

  for (const candidates of bySource.values()) {
    const usedAgentIds = new Set<string>()
    const sorted = [...candidates].sort((a, b) => (a.endTimestamp ?? '').localeCompare(b.endTimestamp ?? ''))

    for (const candidate of sorted) {
      if (candidate.agentType === null || candidate.endTimestamp === null) continue
      const candidateEpoch = toEpochMs(candidate.endTimestamp)
      if (candidateEpoch === null) continue

      let bestAgentId: string | null = null
      let bestDiff = Infinity
      for (const anchor of anchorInfos) {
        if (usedAgentIds.has(anchor.agentId)) continue
        if (anchor.agentType !== candidate.agentType || anchor.endTimestamp === null) continue
        const anchorEpoch = toEpochMs(anchor.endTimestamp)
        if (anchorEpoch === null) continue
        const diff = Math.abs(anchorEpoch - candidateEpoch)
        if (diff <= toleranceMs && diff < bestDiff) {
          bestDiff = diff
          bestAgentId = anchor.agentId
        }
      }

      if (bestAgentId !== null) {
        usedAgentIds.add(bestAgentId)
        executions.get(bestAgentId)!.events.push(candidate)
        matchedEventIds.add(candidate.eventId)
      }
    }
  }

  // 突合対象外(中間状態)、または対応するアンカーが見つからなかった自己申告は単独扱いにする。
  for (const event of selfReportEvents) {
    if (matchedEventIds.has(event.eventId)) continue
    executions.set(event.eventId, { agentId: event.eventId, events: [event] })
  }

  return [...executions.values()]
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event.test.ts`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/canonical-event.ts scripts/lib/canonical-event.test.ts
git commit -m "feat: correlateEvents()にStage2(agentType+時刻窓フォールバック)を実装(issue #569)"
```

---

### Task 9: 等価性テスト

**Files:**
- Create: `scripts/lib/canonical-event-gap-check-equivalence.test.ts`

**Interfaces:**
- Consumes: `agentProgressAdapter`, `loopObservabilityAdapter`, `journalAdapter`, `subagentSkeletonAdapter`（Task 2-5）

- [ ] **Step 1: テストを書く（この段階で全てPASSする想定。既存Adapterの動作を別の角度から確認する回帰テストのため、Red確認はスキップ可）**

```ts
// scripts/lib/canonical-event-gap-check-equivalence.test.ts
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
```

- [ ] **Step 2: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/canonical-event-gap-check-equivalence.test.ts`
Expected: PASS（Task 2-5で実装済みのAdapterに対する回帰テストのため）

- [ ] **Step 3: コミット**

```bash
git add scripts/lib/canonical-event-gap-check-equivalence.test.ts
git commit -m "test: canonical-event.tsの等価性テストを追加(issue #569)"
```

---

### Task 10: verify-agent-progress-transcript.tsのリファクタ

**Files:**
- Modify: `scripts/lib/verify-agent-progress-transcript.ts`
- Modify: `scripts/lib/verify-agent-progress-transcript.test.ts`

**Interfaces:**
- Consumes: `loadAllEvents`, `correlateEvents`, `CorrelatedExecution`, `CanonicalEvent`, `extractAgentType`, `KNOWN_AGENT_TYPES`（`./canonical-event`）
- Produces: `compareStatus`, `compareDetail`, `LOW_OVERLAP_THRESHOLD`, `VerificationReportEntry`, `VerificationReport`, `buildReport(correlated: CorrelatedExecution[]): VerificationReport`（シグネチャ変更）

- [ ] **Step 1: 新しい`buildReport`シグネチャに合わせてテストを書き換える**

```ts
// scripts/lib/verify-agent-progress-transcript.test.ts を全面的に書き換える
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/verify-agent-progress-transcript.test.ts`
Expected: FAIL（`buildReport`が旧シグネチャ`(selfReports, transcripts)`のまま）

- [ ] **Step 3: `verify-agent-progress-transcript.ts`を全面的に書き換える**

```ts
// scripts/lib/verify-agent-progress-transcript.ts
import { loadAllEvents, correlateEvents, type CanonicalEvent, type CorrelatedExecution } from './canonical-event'

export type StatusComparison = 'match' | 'mismatch' | 'unknown'

// WHY: 自己申告は進捗ライフサイクル語彙(done/failed)、transcriptは成果語彙(pass/fail/blocked)で
//      語彙が異なる。「done」は成功系(pass/blocked)、「failed」は失敗(fail)に対応すると解釈する。
//      blockedは仕様確認待ち等の正常な停止でも起こりうるため、doneとの不一致とはみなさない。
export function compareStatus(selfStatus: string, anchorStatus: 'pass' | 'fail' | 'blocked' | null): StatusComparison {
  if (anchorStatus === null) return 'unknown'
  if (selfStatus === 'done') {
    return anchorStatus === 'fail' ? 'mismatch' : 'match'
  }
  if (selfStatus === 'failed') {
    return anchorStatus === 'pass' ? 'mismatch' : 'match'
  }
  return 'unknown'
}

export type DetailComparison = 'match' | 'low_overlap' | 'unknown'

function charBigrams(text: string): Set<string> {
  const normalized = text.replace(/\s+/g, '')
  const bigrams = new Set<string>()
  for (let i = 0; i < normalized.length - 1; i++) {
    bigrams.add(normalized.slice(i, i + 2))
  }
  return bigrams
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

// WHY: LLMを使わずに日本語の自由記述同士の関連度を見るため、文字bigramのJaccard類似度を使う
//      （分かち書き不要・軽量）。閾値未満は「低一致=要目視確認」という弱いシグナルに留め、
//      機械的な確定NG扱いにはしない（自己申告note・transcript detailは表現が違って当然のため）。
export const LOW_OVERLAP_THRESHOLD = 0.08

export function compareDetail(note: string, detail: string | null): DetailComparison {
  if (!detail || detail.trim().length === 0 || !note || note.trim().length === 0) return 'unknown'
  const similarity = jaccardSimilarity(charBigrams(note), charBigrams(detail))
  return similarity < LOW_OVERLAP_THRESHOLD ? 'low_overlap' : 'match'
}

export interface VerificationReportEntry {
  selfEvent: CanonicalEvent
  anchorEvent: CanonicalEvent
  statusComparison: StatusComparison
  detailComparison: DetailComparison
}

export interface VerificationReport {
  totalSelfReports: number
  matchedCount: number
  unmatchedSelf: CanonicalEvent[]
  mismatches: VerificationReportEntry[]
  lowOverlapDetails: VerificationReportEntry[]
}

// issue #569: 突合ロジック(agentId厳密一致 + agentType/時刻窓フォールバック)は
// canonical-event.tsのcorrelateEvents()へ移設した。ここでは正規化済みの
// CorrelatedExecution[]から、意味変換(status/detailの一致判定)とレポート整形のみを行う。
export function buildReport(correlated: CorrelatedExecution[]): VerificationReport {
  const entries: VerificationReportEntry[] = []
  const unmatchedSelf: CanonicalEvent[] = []
  let totalSelfReports = 0

  for (const exec of correlated) {
    const selfEvent = exec.events.find(
      (e) => e.source === 'agent-progress' && (e.status === 'done' || e.status === 'failed'),
    )
    if (!selfEvent) continue
    totalSelfReports += 1

    const anchorEvent = exec.events.find((e) => e.source === 'journal' || e.source === 'subagent-skeleton')
    if (!anchorEvent || anchorEvent.status === null) {
      unmatchedSelf.push(selfEvent)
      continue
    }

    entries.push({
      selfEvent,
      anchorEvent,
      statusComparison: compareStatus(selfEvent.status ?? '', anchorEvent.status as 'pass' | 'fail' | 'blocked'),
      detailComparison: compareDetail(selfEvent.detail ?? '', anchorEvent.detail),
    })
  }

  return {
    totalSelfReports,
    matchedCount: entries.length,
    unmatchedSelf,
    mismatches: entries.filter((entry) => entry.statusComparison === 'mismatch'),
    lowOverlapDetails: entries.filter((entry) => entry.detailComparison === 'low_overlap'),
  }
}

function main() {
  const args = process.argv.slice(2)
  const getArg = (name: string, fallback: string) => {
    const index = args.indexOf(name)
    return index === -1 ? fallback : args[index + 1]
  }

  const agentProgressLogFile = getArg('--log-file', 'logs/agent-progress.jsonl')
  const subagentSkeletonLogFile = getArg('--skeleton-log-file', 'logs/subagent-skeleton.jsonl')
  const projectDir = getArg(
    '--project-dir',
    `${process.env.HOME ?? ''}/.claude/projects/-Users-masanori-medical-inventory-vkumai`,
  )
  const asJson = args.includes('--json')

  const events = loadAllEvents({ agentProgressLogFile, subagentSkeletonLogFile, projectDir })
  const correlated = correlateEvents(events)
  const report = buildReport(correlated)

  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(
      `自己申告(done/failed): ${report.totalSelfReports}件 / 突合成功: ${report.matchedCount}件 / 未対応(未突合): ${report.unmatchedSelf.length}件`,
    )
    if (report.mismatches.length > 0) {
      console.log(`\n食い違い(status): ${report.mismatches.length}件`)
      for (const entry of report.mismatches) {
        console.log(
          `  - agentType=${entry.selfEvent.agentType} feature=${entry.selfEvent.feature} 自己申告=${entry.selfEvent.status}(${entry.selfEvent.detail}) anchor=${entry.anchorEvent.status}(${entry.anchorEvent.detail ?? ''})`,
        )
      }
    }
    if (report.lowOverlapDetails.length > 0) {
      console.log(`\ndetail低一致(要目視確認・弱いシグナル): ${report.lowOverlapDetails.length}件`)
      for (const entry of report.lowOverlapDetails) {
        console.log(
          `  - agentType=${entry.selfEvent.agentType} feature=${entry.selfEvent.feature} note="${entry.selfEvent.detail}" detail="${entry.anchorEvent.detail ?? ''}"`,
        )
      }
    }
  }

  if (report.mismatches.length > 0) {
    process.exitCode = 1
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

- [ ] **Step 4: テストを実行して成功を確認する**

Run: `npx vitest run scripts/lib/verify-agent-progress-transcript.test.ts scripts/lib/canonical-event.test.ts scripts/lib/canonical-event-gap-check-equivalence.test.ts`
Expected: 全てPASS

- [ ] **Step 5: `npm test`全体を実行し、他への影響が無いことを確認する**

Run: `npm test`
Expected: 全体PASS（既存の他テストに影響が無いこと）

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/verify-agent-progress-transcript.ts scripts/lib/verify-agent-progress-transcript.test.ts
git commit -m "refactor: verify-agent-progress-transcript.tsをcanonical-event.ts経由に統合(issue #569)"
```

---

### Task 11: ドキュメント更新

**Files:**
- Modify: `docs/agents/observability-internals.md`
- Modify: `docs/agents/common.md`

- [ ] **Step 1: `docs/agents/observability-internals.md`に統合の説明を追記する**

`## agent-progress記録の構造的限界・記録内容検証の詳細`セクションの末尾（`## サブエージェント骨格記録の機械強制（issue #423）`の直前）に以下を追記する:

```markdown
## canonical event moduleへの統合（issue #569）

上記4つのログ（agent-progress/loop-observability/subagent-skeleton/journal）は`scripts/lib/canonical-event.ts`
が読み取り専用Adapterとして正規化する。設計・突合アルゴリズム・実機検証結果（hookのagent_idと
journal.jsonlのagentIdが同一空間であることを確認済み）は
[`docs/superpowers/specs/2026-07-27-canonical-event-module-design.md`](../superpowers/specs/2026-07-27-canonical-event-module-design.md)参照。
`verify-agent-progress-transcript.ts`は本モジュール経由の薄いラッパーに統合済み。既存gap check
bashスクリプト（`check-loop-observability-gap.sh`等）・ログ書き込み側は無改修のまま。
```

- [ ] **Step 2: `docs/agents/common.md`の「重要ファイルへのパス」表に1行追加する**

`scripts/verify-agent-progress-transcript.sh` の行の直後に追加:

```markdown
| `scripts/lib/canonical-event.ts` | hook/journal/agent-progress/loop-observabilityの4ログを正規化する読み取り専用Adapter層（issue #569） |
```

- [ ] **Step 3: コミット**

```bash
git add docs/agents/observability-internals.md docs/agents/common.md
git commit -m "docs: canonical event module統合をobservability-internals.md/common.mdに反映(issue #569)"
```

---

## Self-Review 結果

- **spec coverage**: 仕様書の全セクション（アーキテクチャ／データ型／突合アルゴリズム／Adapter詳細／消費側移行／テスト計画／ファイル一覧）に対応するタスクが存在する（Task 1〜11）
- **placeholder scan**: 全ステップに実コードを記載済み。TBD/TODOなし
- **type consistency**: `CanonicalEvent`/`CorrelatedExecution`/`EventAdapter`の型・フィールド名はTask 1で定義したものをTask 2以降で一貫して使用している
