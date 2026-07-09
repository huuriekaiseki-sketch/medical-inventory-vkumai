# Loop Observability Step7（tokens/costUsd後付け集計）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `logs/loop-observability.jsonl` の既存レコード（`tokens`/`costUsd` が常に `null`）に対し、`~/.claude/projects/` 配下のtranscript jsonlから実usageを突合してベストエフォートで後付け更新するスクリプトを追加する。

**Architecture:** 設計ドキュメント（`docs/superpowers/specs/2026-07-02-loop-observability-design.md`）が前提としていた「timestamp + agent + attempt」突合は、transcript側に `attempt` 情報が存在しないため成立しない（前段の調査で確認済み）。代わりに以下の方式を採用する：

1. `logs/loop-observability.jsonl` を `feature` ごとにグルーピングし、timestampで昇順ソート。各レコードについて「直前の同一feature内レコードのtimestamp（exclusive）〜自レコードのtimestamp（inclusive）」を時間窓とする（ログ書き込みは試行完了後に行われるため、実作業は必ずこの窓の中に収まる）
2. transcriptの各メッセージ行にある `attributionAgent` フィールドが `logs` レコードの `agent` フィールドと一致し、かつ `timestamp` が窓に収まるものだけを usage 集計対象とする。**検証済み（2026-07-09、実データ全件集計）:** `~/.claude/projects/-Users-masanori-medical-inventory-vkumai/**/subagents/*.jsonl` のassistantメッセージ11,979件中11,978件（99.99%）に `attributionAgent` が存在する。一方、サブエージェント以外のメインtranscript（`**/*.jsonl` かつ `subagents/` 配下でないもの）のassistantメッセージ7,305件には `attributionAgent` は1件も存在しない。これは設計ドキュメントの「agentフィールドの値域ルール」（AIエージェント名は必ず `.claude/agents/` 定義のサブエージェントとして起動される前提で、メインループ自身が `agent` にAI名を書くことは想定していない）と整合するため、メインtranscriptも含めて全走査しても誤マッチにはならない（単に0件寄与するだけ）。ただし、将来サブエージェントを介さずメインループ内でAI名を自己申告する運用が発生した場合はその記録が恒久的に突合できなくなる点に注意（Task 6 Step 3の突合率チェックで検知する）
3. `agent === "human"` または `"e2e-runner"` のレコードは対応transcriptが無いため最初からスキップ対象とする
4. `requestId` で重複除去し、モデル名ごとの単価表で `costUsd` を計算する
5. 突合できなかった件数は必ずログ出力する（サイレントな取りこぼし禁止）

この方式は近似（ベストエフォート）であり、100%の精度は保証しない。Step7自体が「任意・後日」の位置づけであることと整合する。

**Tech Stack:** TypeScript + `npx tsx`（プロジェクトの `e2e:auth` と同じ実行方式）、テストは `vitest run`（package.json:10 の既存テストコマンドと同じランナー）。Node標準ライブラリのみ使用し外部依存を増やさない。

## Global Constraints

- このタスクは `supabase/migrations/`・`src/lib/supabase/`・`middleware.ts`・auth/facility/tenant/organization/inventory/RLS/policy のいずれにも触れないため、TRI/RISK機械判定の対象外（軽量レーンで進めてよい）
- `logs/loop-observability.jsonl` の既存スキーマ（フィールド構成）は変更しない。値の埋め込みのみ行う（設計ドキュメント原則を維持）
- モデル単価表の数値は本計画作成時点の目安であり未検証。Task 1で明示的に確認手順を踏む
- 実在の施設名・実データをテストフィクスチャに含めない（`docs/agents/common.md` のテスト衛生ルール）

---

## File Structure

- `scripts/lib/model-pricing.ts` — モデル名→100万トークンあたりのUSD単価（input/output/cacheWrite/cacheRead）を返すテーブルと `getPricing()` 関数
- `scripts/lib/model-pricing.test.ts` — 単価表の解決ロジックのテスト
- `scripts/lib/aggregate-loop-observability-usage.ts` — 突合・集計のコアロジック（純粋関数群）+ CLIエントリポイント
- `scripts/lib/aggregate-loop-observability-usage.test.ts` — フィクスチャjsonlを使った突合ロジックのテスト
- `scripts/update-loop-observability-usage.sh` — `npx tsx` 経由でCLIを起動するラッパー（既存の `scripts/*.sh` の呼び出し形式に合わせる）
- 既存修正: `scripts/summarize-loop-observability.sh` — tokens/costUsd集計セクションを追加
- 既存修正: `docs/superpowers/specs/2026-07-02-loop-observability-design.md` — Step7の突合方式記述（86-89行目）を実データに基づく方式へ更新

---

### Task 1: モデル単価表モジュール

**Files:**
- Create: `scripts/lib/model-pricing.ts`
- Test: `scripts/lib/model-pricing.test.ts`

**Interfaces:**
- Produces: `export interface ModelPricing { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number }`
- Produces: `export function getPricing(model: string): ModelPricing | null`

- [ ] **Step 1: 単価表の数値をAnthropic公式price page（console.anthropic.com/pricing）で確認する**

このステップはコードを書く前の人間確認が必要。実装者は以下の値をベストエフォートの初期値として使い、必ず実装完了前に公式ページと突き合わせて修正すること（未検証のまま放置しない）。

- [ ] **Step 2: 失敗するテストを書く**

```typescript
// scripts/lib/model-pricing.test.ts
import { describe, expect, it } from 'vitest'
import { getPricing } from './model-pricing'

describe('getPricing', () => {
  it('known model名に対して単価を返す', () => {
    const pricing = getPricing('claude-sonnet-5')
    expect(pricing).not.toBeNull()
    expect(pricing?.inputPerMTok).toBeGreaterThan(0)
    expect(pricing?.outputPerMTok).toBeGreaterThan(pricing?.inputPerMTok ?? 0)
  })

  it('未知のモデル名にはnullを返す（fallbackで誤ったコストを計算しない）', () => {
    expect(getPricing('unknown-model-xyz')).toBeNull()
  })

  it('モデル名のバリエーション（バージョンサフィックス付き）も解決できる', () => {
    expect(getPricing('claude-haiku-4-5-20251001')).not.toBeNull()
  })
})
```

- [ ] **Step 3: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/model-pricing.test.ts`
Expected: FAIL（`model-pricing.ts` が存在しない）

- [ ] **Step 4: 実装する**

```typescript
// scripts/lib/model-pricing.ts
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheWritePerMTok: number
  cacheReadPerMTok: number
}

// 単価は 100万トークンあたりのUSD。要検証: console.anthropic.com/pricing で最新値を確認すること。
const MODEL_PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-8': { inputPerMTok: 15, outputPerMTok: 75, cacheWritePerMTok: 18.75, cacheReadPerMTok: 1.5 },
  'claude-sonnet-5': { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  'claude-fable-5': { inputPerMTok: 3, outputPerMTok: 15, cacheWritePerMTok: 3.75, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5, cacheWritePerMTok: 1.25, cacheReadPerMTok: 0.1 },
}

export function getPricing(model: string): ModelPricing | null {
  return MODEL_PRICING_TABLE[model] ?? null
}
```

- [ ] **Step 5: テストを実行してパスを確認する**

Run: `npx vitest run scripts/lib/model-pricing.test.ts`
Expected: PASS（3件）

- [ ] **Step 6: コミット**

```bash
git add scripts/lib/model-pricing.ts scripts/lib/model-pricing.test.ts
git commit -m "feat: loop observability用モデル単価表を追加"
```

---

### Task 2: 突合・集計のコアロジック

**Files:**
- Create: `scripts/lib/aggregate-loop-observability-usage.ts`
- Test: `scripts/lib/aggregate-loop-observability-usage.test.ts`

**Interfaces:**
- Consumes: `getPricing(model: string): ModelPricing | null`（Task 1）
- Produces:
  - `export interface LoopObservabilityEntry { timestamp: string; loop: string; agent: string; feature: string; attempt: number; model: string | null; tokens: number | null; costUsd: number | null; intent: string; scenario: string; result: string; reason: string }`
  - `export interface UsageEvent { timestamp: string; model: string; attributionAgent: string | null; requestId: string; inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number }`
  - `export function computeWindow(entries: LoopObservabilityEntry[], index: number): { start: string; end: string }`
  - `export function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[]`
  - `export function matchUsage(entry: LoopObservabilityEntry, window: { start: string; end: string }, events: UsageEvent[]): UsageEvent[]`
  - `export function computeCost(events: UsageEvent[]): number | null`（単価が不明なモデルが1件でも混在したら `null` を返し、部分的な過小評価を出さない）
  - `export function aggregate(entries: LoopObservabilityEntry[], events: UsageEvent[]): { updated: LoopObservabilityEntry[]; stats: { total: number; matched: number; skippedNoTarget: number; skippedNoUsage: number } }`

- [ ] **Step 1: 失敗するテストを書く（フィクスチャベース）**

```typescript
// scripts/lib/aggregate-loop-observability-usage.test.ts
import { describe, expect, it } from 'vitest'
import {
  computeWindow,
  dedupeUsageEvents,
  matchUsage,
  computeCost,
  aggregate,
  type LoopObservabilityEntry,
  type UsageEvent,
} from './aggregate-loop-observability-usage'

function entry(overrides: Partial<LoopObservabilityEntry>): LoopObservabilityEntry {
  return {
    timestamp: '2026-07-08T00:30:00Z',
    loop: 'agentic',
    agent: 'implementer',
    feature: 'sample-feature',
    attempt: 1,
    model: 'claude-sonnet-5',
    tokens: null,
    costUsd: null,
    intent: 'テスト用ダミー意図',
    scenario: 'テスト用ダミーシナリオ',
    result: 'pass',
    reason: 'テスト用ダミー理由',
    ...overrides,
  }
}

function usage(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    timestamp: '2026-07-08T00:29:30.000Z',
    model: 'claude-sonnet-5',
    attributionAgent: 'implementer',
    requestId: 'req_1',
    inputTokens: 1000,
    outputTokens: 500,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    ...overrides,
  }
}

describe('computeWindow', () => {
  it('先頭レコードの窓開始はエポック0', () => {
    const entries = [entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' })]
    const window = computeWindow(entries, 0)
    expect(window.start).toBe('1970-01-01T00:00:00.000Z')
    expect(window.end).toBe('2026-07-08T00:30:00Z')
  })

  it('同一feature内では直前レコードのtimestampが窓開始になる', () => {
    const entries = [
      entry({ feature: 'a', timestamp: '2026-07-08T00:10:00Z' }),
      entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' }),
    ]
    const window = computeWindow(entries, 1)
    expect(window.start).toBe('2026-07-08T00:10:00Z')
    expect(window.end).toBe('2026-07-08T00:30:00Z')
  })

  it('featureが異なるレコードは窓計算に影響しない', () => {
    const entries = [
      entry({ feature: 'other', timestamp: '2026-07-08T00:05:00Z' }),
      entry({ feature: 'a', timestamp: '2026-07-08T00:30:00Z' }),
    ]
    const window = computeWindow(entries, 1)
    expect(window.start).toBe('1970-01-01T00:00:00.000Z')
  })
})

describe('dedupeUsageEvents', () => {
  it('同一requestIdは合計トークン数が最大のものを1件だけ残す', () => {
    const events = [
      usage({ requestId: 'req_1', outputTokens: 100 }),
      usage({ requestId: 'req_1', outputTokens: 500 }),
    ]
    const result = dedupeUsageEvents(events)
    expect(result).toHaveLength(1)
    expect(result[0].outputTokens).toBe(500)
  })
})

describe('matchUsage', () => {
  it('agent一致かつ窓内のイベントだけを返す', () => {
    const window = { start: '2026-07-08T00:00:00Z', end: '2026-07-08T00:30:00Z' }
    const events = [
      usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:15:00.000Z' }),
      usage({ attributionAgent: 'reviewer', timestamp: '2026-07-08T00:15:00.000Z' }),
      usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:45:00.000Z' }),
    ]
    const result = matchUsage(entry({ agent: 'implementer' }), window, events)
    expect(result).toHaveLength(1)
  })
})

describe('computeCost', () => {
  it('既知モデルのイベントからコストを計算する', () => {
    const cost = computeCost([usage({ model: 'claude-sonnet-5', inputTokens: 1_000_000, outputTokens: 1_000_000 })])
    expect(cost).toBeCloseTo(3 + 15, 5)
  })

  it('未知モデルが混ざっていたらnullを返す（過小評価しない）', () => {
    const cost = computeCost([usage({ model: 'unknown-model' })])
    expect(cost).toBeNull()
  })
})

describe('aggregate', () => {
  it('human/e2e-runnerはtranscript対象外としてスキップ集計する', () => {
    const entries = [entry({ agent: 'human' }), entry({ agent: 'e2e-runner' })]
    const result = aggregate(entries, [])
    expect(result.stats.skippedNoTarget).toBe(2)
    expect(result.updated[0].tokens).toBeNull()
    expect(result.updated[1].tokens).toBeNull()
  })

  it('突合できたレコードはtokens/costUsdが埋まり、他フィールドは変化しない', () => {
    const entries = [entry({ feature: 'a', agent: 'implementer', timestamp: '2026-07-08T00:30:00Z' })]
    const events = [usage({ attributionAgent: 'implementer', timestamp: '2026-07-08T00:15:00.000Z' })]
    const result = aggregate(entries, events)
    expect(result.stats.matched).toBe(1)
    expect(result.updated[0].tokens).toBe(1500)
    expect(result.updated[0].costUsd).not.toBeNull()
    expect(result.updated[0].intent).toBe(entries[0].intent)
  })

  it('窓内に一致するusageが無ければskippedNoUsageに計上する', () => {
    const entries = [entry({ feature: 'a', agent: 'implementer', timestamp: '2026-07-08T00:30:00Z' })]
    const result = aggregate(entries, [])
    expect(result.stats.skippedNoUsage).toBe(1)
    expect(result.updated[0].tokens).toBeNull()
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/aggregate-loop-observability-usage.test.ts`
Expected: FAIL（ファイルが存在しない）

- [ ] **Step 3: 実装する**

```typescript
// scripts/lib/aggregate-loop-observability-usage.ts
import { getPricing } from './model-pricing'

export interface LoopObservabilityEntry {
  timestamp: string
  loop: string
  agent: string
  feature: string
  attempt: number
  model: string | null
  tokens: number | null
  costUsd: number | null
  intent: string
  scenario: string
  result: string
  reason: string
}

export interface UsageEvent {
  timestamp: string
  model: string
  attributionAgent: string | null
  requestId: string
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

const NO_TRANSCRIPT_AGENTS = new Set(['human', 'e2e-runner'])
const EPOCH = '1970-01-01T00:00:00.000Z'

export function computeWindow(
  entries: LoopObservabilityEntry[],
  index: number,
): { start: string; end: string } {
  const target = entries[index]
  let start = EPOCH
  for (let i = index - 1; i >= 0; i--) {
    if (entries[i].feature === target.feature) {
      start = entries[i].timestamp
      break
    }
  }
  return { start, end: target.timestamp }
}

export function dedupeUsageEvents(events: UsageEvent[]): UsageEvent[] {
  const byRequestId = new Map<string, UsageEvent>()
  for (const event of events) {
    const existing = byRequestId.get(event.requestId)
    const total = event.inputTokens + event.outputTokens
    const existingTotal = existing ? existing.inputTokens + existing.outputTokens : -1
    if (!existing || total > existingTotal) {
      byRequestId.set(event.requestId, event)
    }
  }
  return [...byRequestId.values()]
}

export function matchUsage(
  entry: LoopObservabilityEntry,
  window: { start: string; end: string },
  events: UsageEvent[],
): UsageEvent[] {
  return events.filter(
    (event) =>
      event.attributionAgent === entry.agent &&
      event.timestamp > window.start &&
      event.timestamp <= window.end,
  )
}

export function computeCost(events: UsageEvent[]): number | null {
  let total = 0
  for (const event of events) {
    const pricing = getPricing(event.model)
    if (!pricing) return null
    total +=
      (event.inputTokens / 1_000_000) * pricing.inputPerMTok +
      (event.outputTokens / 1_000_000) * pricing.outputPerMTok +
      (event.cacheCreationInputTokens / 1_000_000) * pricing.cacheWritePerMTok +
      (event.cacheReadInputTokens / 1_000_000) * pricing.cacheReadPerMTok
  }
  return total
}

export function aggregate(
  entries: LoopObservabilityEntry[],
  rawEvents: UsageEvent[],
): {
  updated: LoopObservabilityEntry[]
  stats: { total: number; matched: number; skippedNoTarget: number; skippedNoUsage: number }
} {
  const events = dedupeUsageEvents(rawEvents)
  const stats = { total: entries.length, matched: 0, skippedNoTarget: 0, skippedNoUsage: 0 }

  const updated = entries.map((entry, index) => {
    if (NO_TRANSCRIPT_AGENTS.has(entry.agent)) {
      stats.skippedNoTarget++
      return entry
    }
    const window = computeWindow(entries, index)
    const matched = matchUsage(entry, window, events)
    if (matched.length === 0) {
      stats.skippedNoUsage++
      return entry
    }
    const tokens = matched.reduce((sum, e) => sum + e.inputTokens + e.outputTokens, 0)
    const costUsd = computeCost(matched)
    stats.matched++
    return { ...entry, tokens, costUsd }
  })

  return { updated, stats }
}
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npx vitest run scripts/lib/aggregate-loop-observability-usage.test.ts`
Expected: PASS（全件）

- [ ] **Step 5: コミット**

```bash
git add scripts/lib/aggregate-loop-observability-usage.ts scripts/lib/aggregate-loop-observability-usage.test.ts
git commit -m "feat: loop observabilityのtimestamp+attributionAgent突合ロジックを追加"
```

---

### Task 3: transcript読み込み・ログ書き換えCLI

**Files:**
- Modify: `scripts/lib/aggregate-loop-observability-usage.ts`（CLIエントリポイントを追加）
- Create: `scripts/update-loop-observability-usage.sh`
- Test: `scripts/lib/aggregate-loop-observability-usage.test.ts`（`loadUsageEventsFromTranscripts`・`loadLogEntries`・`writeLogEntries` の追加テスト）

**Interfaces:**
- Consumes: `aggregate()`（Task 2）
- Produces:
  - `export function parseTranscriptLine(line: string): UsageEvent | null`
  - `export function loadUsageEventsFromTranscripts(projectsRoot: string): UsageEvent[]`
  - `export function loadLogEntries(logFilePath: string): LoopObservabilityEntry[]`
  - `export function writeLogEntries(logFilePath: string, entries: LoopObservabilityEntry[]): void`

- [ ] **Step 1: 失敗するテストを追記する**

```typescript
// scripts/lib/aggregate-loop-observability-usage.test.ts に追記
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseTranscriptLine, loadUsageEventsFromTranscripts, loadLogEntries, writeLogEntries } from './aggregate-loop-observability-usage'

describe('parseTranscriptLine', () => {
  it('assistantメッセージのusage行をUsageEventに変換する', () => {
    const line = JSON.stringify({
      type: 'assistant',
      attributionAgent: 'implementer',
      requestId: 'req_abc',
      timestamp: '2026-07-08T00:15:00.000Z',
      message: {
        model: 'claude-sonnet-5',
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    })
    const event = parseTranscriptLine(line)
    expect(event).toEqual({
      timestamp: '2026-07-08T00:15:00.000Z',
      model: 'claude-sonnet-5',
      attributionAgent: 'implementer',
      requestId: 'req_abc',
      inputTokens: 100,
      outputTokens: 50,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    })
  })

  it('usageの無い行（userメッセージ等）はnullを返す', () => {
    expect(parseTranscriptLine(JSON.stringify({ type: 'user' }))).toBeNull()
  })

  it('壊れたJSON行はnullを返す（クラッシュしない）', () => {
    expect(parseTranscriptLine('{not valid json')).toBeNull()
  })
})

describe('loadUsageEventsFromTranscripts + loadLogEntries + writeLogEntries', () => {
  it('ディレクトリ配下の*.jsonlを再帰的に読み込む', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-obs-test-'))
    mkdirSync(join(root, 'session1', 'subagents'), { recursive: true })
    writeFileSync(
      join(root, 'session1', 'subagents', 'agent-1.jsonl'),
      JSON.stringify({
        type: 'assistant',
        attributionAgent: 'implementer',
        requestId: 'req_x',
        timestamp: '2026-07-08T00:15:00.000Z',
        message: { model: 'claude-sonnet-5', usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
      }) + '\n',
    )
    const events = loadUsageEventsFromTranscripts(root)
    expect(events).toHaveLength(1)
    expect(events[0].requestId).toBe('req_x')
  })

  it('loadLogEntriesとwriteLogEntriesはラウンドトリップでフィールドを保持する', () => {
    const root = mkdtempSync(join(tmpdir(), 'loop-obs-log-test-'))
    const logPath = join(root, 'loop-observability.jsonl')
    const original = [
      {
        timestamp: '2026-07-08T00:30:00Z', loop: 'agentic', agent: 'implementer', feature: 'a',
        attempt: 1, model: 'claude-sonnet-5', tokens: null, costUsd: null,
        intent: 'ダミー', scenario: 'ダミー', result: 'pass', reason: 'ダミー',
      },
    ]
    writeLogEntries(logPath, original)
    const reloaded = loadLogEntries(logPath)
    expect(reloaded).toEqual(original)
    const raw = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(raw).toHaveLength(1)
  })
})
```

- [ ] **Step 2: テストを実行して失敗を確認する**

Run: `npx vitest run scripts/lib/aggregate-loop-observability-usage.test.ts`
Expected: FAIL（3関数が未定義）

- [ ] **Step 3: 実装を追記する**

```typescript
// scripts/lib/aggregate-loop-observability-usage.ts に追記
import { readdirSync, readFileSync as fsReadFileSync, statSync, writeFileSync as fsWriteFileSync } from 'node:fs'
import { join } from 'node:path'

export function parseTranscriptLine(line: string): UsageEvent | null {
  let parsed: any
  try {
    parsed = JSON.parse(line)
  } catch {
    return null
  }
  const usage = parsed?.message?.usage
  if (!usage || typeof usage.input_tokens !== 'number') return null
  return {
    timestamp: parsed.timestamp,
    model: parsed.message.model,
    attributionAgent: parsed.attributionAgent ?? null,
    requestId: parsed.requestId ?? parsed.uuid,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  }
}

function findJsonlFiles(root: string): string[] {
  const result: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) {
        walk(full)
      } else if (name.endsWith('.jsonl')) {
        result.push(full)
      }
    }
  }
  walk(root)
  return result
}

export function loadUsageEventsFromTranscripts(projectsRoot: string): UsageEvent[] {
  const events: UsageEvent[] = []
  for (const file of findJsonlFiles(projectsRoot)) {
    const lines = fsReadFileSync(file, 'utf-8').split('\n').filter(Boolean)
    for (const line of lines) {
      const event = parseTranscriptLine(line)
      if (event) events.push(event)
    }
  }
  return events
}

export function loadLogEntries(logFilePath: string): LoopObservabilityEntry[] {
  const lines = fsReadFileSync(logFilePath, 'utf-8').split('\n').filter(Boolean)
  return lines.map((line) => JSON.parse(line) as LoopObservabilityEntry)
}

export function writeLogEntries(logFilePath: string, entries: LoopObservabilityEntry[]): void {
  const content = entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'
  fsWriteFileSync(logFilePath, content, 'utf-8')
}
```

- [ ] **Step 4: テストを実行してパスを確認する**

Run: `npx vitest run scripts/lib/aggregate-loop-observability-usage.test.ts`
Expected: PASS（全件）

- [ ] **Step 5: CLIエントリポイントを追記する**

```typescript
// scripts/lib/aggregate-loop-observability-usage.ts の末尾に追記
function main() {
  const logFilePath = process.argv[2] ?? 'logs/loop-observability.jsonl'
  const projectsRoot = process.argv[3] ?? join(process.env.HOME ?? '', '.claude/projects')

  const entries = loadLogEntries(logFilePath)
  const events = loadUsageEventsFromTranscripts(projectsRoot)
  const { updated, stats } = aggregate(entries, events)
  writeLogEntries(logFilePath, updated)

  console.log(`total=${stats.total} matched=${stats.matched} skippedNoTarget(human/e2e-runner)=${stats.skippedNoTarget} skippedNoUsage(突合失敗)=${stats.skippedNoUsage}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
```

- [ ] **Step 6: ラッパーシェルスクリプトを作成する**

```bash
#!/usr/bin/env bash
# scripts/update-loop-observability-usage.sh
set -euo pipefail

LOG_FILE="${1:-logs/loop-observability.jsonl}"
PROJECTS_ROOT="${2:-$HOME/.claude/projects}"

npx -y tsx scripts/lib/aggregate-loop-observability-usage.ts "$LOG_FILE" "$PROJECTS_ROOT"
```

Run: `chmod +x scripts/update-loop-observability-usage.sh`

- [ ] **Step 7: コミット**

```bash
git add scripts/lib/aggregate-loop-observability-usage.ts scripts/lib/aggregate-loop-observability-usage.test.ts scripts/update-loop-observability-usage.sh
git commit -m "feat: transcript読み込み・ログ書き換えCLIを追加"
```

---

### Task 4: summarize-loop-observability.sh にtokens/costUsd集計を追加

**Files:**
- Modify: `scripts/summarize-loop-observability.sh:41-61`（Feature別セクションのjqテンプレート）

**Interfaces:**
- Consumes: `logs/loop-observability.jsonl` の `tokens`/`costUsd`（Task 3のCLI実行後に埋まっている前提。埋まっていなければ `null` のまま集計してよい＝jqの `add // 0` で対応）

- [ ] **Step 1: 既存のjqテンプレートを確認する（Read済みのため実装のみ）**

- [ ] **Step 2: Feature別セクションにtokens/costUsd合計を追加する**

`scripts/summarize-loop-observability.sh:46-59` を以下に置き換える：

```
        ($all | group_by(.feature)[] |
          . as $g |
          ($g[0].feature) as $feature |
          ($g | length) as $attempts |
          ($g | map(select(.result == "pass")) | length) as $p |
          ($g | map(.model) | fmtList) as $models |
          ($g | map(.agent) | fmtList) as $agents |
          ($g | map(.tokens // 0) | add) as $tokens |
          ($g | map(select(.tokens != null)) | length) as $tokensKnown |
          ($g | map(.costUsd // 0) | add) as $cost |
          ($g | map(select(.costUsd != null)) | length) as $costKnown |
          "### \($feature)",
          "- 試行回数: \($attempts)",
          "- 成功: \($p)/\($attempts)",
          "- 使用モデル: \($models)",
          "- agent: \($agents)",
          "- tokens合計: \($tokens)（\($tokensKnown)/\($attempts)件で判明）",
          "- costUsd合計: \($cost | (.*100|round)/100)（\($costKnown)/\($attempts)件で判明）",
          ""
        )
```

- [ ] **Step 3: 既存78行のログに対して動作確認する**

Run: `bash scripts/summarize-loop-observability.sh`
Expected: エラーなく完了し、各featureセクションに `tokens合計` `costUsd合計` の行が出力される（値は現状すべて0/0件、Task 3実行後に変わる）

- [ ] **Step 4: コミット**

```bash
git add scripts/summarize-loop-observability.sh
git commit -m "feat: summarize-loop-observabilityにtokens/costUsd集計を追加"
```

---

### Task 5: 設計ドキュメントの突合方式記述を更新

**Files:**
- Modify: `docs/superpowers/specs/2026-07-02-loop-observability-design.md:86-89`, `104`

**Interfaces:** なし（ドキュメントのみ）

- [ ] **Step 1: 第二段階の記述を実装内容に合わせて修正する**

`docs/superpowers/specs/2026-07-02-loop-observability-design.md:86-89` を以下に置き換える：

```markdown
### 第二段階（Step 7・任意、落ち着いてから着手）
- `~/.claude/projects/` 配下のtranscript jsonl（実際のusageが記録済み）から集計するスクリプトを追加
- **突合方式（2026-07-09改訂）:** 当初想定していた「timestamp + agent + attempt」でのキー突合は、transcript側に`attempt`情報が存在しないため不採用。代わりに、同一`feature`内でtimestamp昇順に並べた「直前レコード〜自レコード」の時間窓と、transcriptの`attributionAgent`フィールド（agent種別名と一致）でのフィルタにより、ベストエフォートで該当usageイベントを特定する
- 突合できなかったレコードは`tokens`/`costUsd`を`null`のまま残し、突合できた件数・できなかった件数を必ずログ出力する（サイレントな取りこぼしを避ける）
- 既存レコードのスキーマ（フィールド構成）は変更しない。値の埋め込みのみ行う
- 実装: `scripts/lib/aggregate-loop-observability-usage.ts`（`scripts/update-loop-observability-usage.sh` 経由で実行）
```

- [ ] **Step 2: ステップアップ計画の表（104行目）を完了状態に更新する**

```markdown
| 7（任意・後日） | transcript集計スクリプトで`tokens`/`costUsd`を後付け更新（第二段階、完了・2026-07-09。突合方式はattempt→timestamp窓+attributionAgentに変更） | `scripts/lib/aggregate-loop-observability-usage.ts`, `scripts/update-loop-observability-usage.sh` |
```

- [ ] **Step 3: コミット**

```bash
git add docs/superpowers/specs/2026-07-02-loop-observability-design.md
git commit -m "docs: Step7の突合方式を実データに基づく方式に更新"
```

---

### Task 6: 実データに対して実行し、突合率を確認する

**Files:** なし（実行のみ、コード変更なし）

- [ ] **Step 1: 既存ログのバックアップを取る**

```bash
cp logs/loop-observability.jsonl logs/loop-observability.jsonl.bak
```

- [ ] **Step 2: 集計スクリプトを実行する**

Run: `bash scripts/update-loop-observability-usage.sh`
Expected: `total=78 matched=N skippedNoTarget(human/e2e-runner)=M skippedNoUsage(突合失敗)=K` の形式で出力され、`N+M+K=78`

- [ ] **Step 3: 突合率が著しく低い場合（例: matched/total < 30%）は原因を調査する**

窓のtimestamp精度（ログ側は秒精度UTC、transcript側はミリ秒UTCなので比較自体は問題ない）や、`attributionAgent`がメイン（非サブエージェント）transcript行に存在しないケース（`agent`がトップレベルAI呼び出しに対応する場合）を疑う。原因が「メインtranscript行にattributionAgentが無い」であれば、Task 2の`matchUsage`にメインtranscript用の代替条件（`isSidechain !== true` かつ `agent`がセッション全体を代表する場合の扱い）を追加で検討する。この判断が必要になった場合は実装を止めて人間に報告する。

- [ ] **Step 4: summarize-loop-observability.sh の出力を確認する**

Run: `bash scripts/summarize-loop-observability.sh`
Expected: feature別に `tokens合計` `costUsd合計` が非ゼロで表示される

- [ ] **Step 5: バックアップを削除する**

```bash
rm logs/loop-observability.jsonl.bak
```
