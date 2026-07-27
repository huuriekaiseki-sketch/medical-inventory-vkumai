# AIDD実行記録 canonical event module 設計

**日付:** 2026-07-27
**対象issue:** [#569](https://github.com/huuriekaiseki-sketch/medical-inventory-vkumai/issues/569)

---

## 背景・目的

アーキテクチャレビュー(2026-07-26)で指摘された通り、同一AIDD実行の意味情報が以下4つのログに分散している。

- `logs/agent-progress.jsonl` — 自己申告。starting/running/waiting/done/failedの状態遷移
- `logs/loop-observability.jsonl` — 自己申告。1 attempt = 1行、pass/fail + intent/scenario/reason
- `logs/subagent-skeleton.jsonl` — `SubagentStart`/`SubagentStop` hookによる機械記録。agent_id/agent_type/timestamp
- `subagents/workflows/wf_*/journal.jsonl` + `agent-<id>.jsonl`/`.meta.json` — Workflow DSL自体が書く構造化result（`agent()`呼び出し時のみ存在）

いずれも共通の実行IDを持たず、既存の`scripts/lib/verify-agent-progress-transcript.ts`はagentType一致＋時刻近接（30分許容）というヒューリスティックで突き合わせている。本設計はこの分散を解消する「canonical execution event module」を定義する。

**非目的:** OTelは定量計測用の別Adapterとして現状維持（統合対象外）。ログの書き込み側（`log-agent-progress.sh`等の自己申告shellスクリプト）・既存gap check bashスクリプトは無改修。

---

## スコープ

**対象:** `scripts/lib/canonical-event.ts`という読み取り専用Adapterモジュールの新設と、既存`verify-agent-progress-transcript.ts`のリファクタ
**対象外:** ログ生成側（各`log-*.sh`）の変更、gap check bashスクリプト（`check-loop-observability-gap.sh`等）自体の変更、OTel統合

---

## アーキテクチャ

新規モジュール`scripts/lib/canonical-event.ts`は、4つの既存ログそれぞれを正規化された`CanonicalEvent`に変換する**Adapter**と、それらを同一実行単位へ突合する`correlateEvents()`を提供する読み取り専用の層である。

- 各ログの書き込み側は無改修
- `verify-agent-progress-transcript.ts`は、正規化・突合ロジックを本モジュールへ委譲する薄いラッパーに変わる（レポート整形・CLI・終了コードのみ残す）
- gap check群(`check-loop-observability-gap.sh`等)は変更しない。代わりに等価性テストで「新モジュールの件数カウントと既存bashロジックが同等であること」を保証する

---

## データ型

```ts
export type EventSource = 'subagent-skeleton' | 'journal' | 'agent-progress' | 'loop-observability'
export type EventStatus = 'pass' | 'fail' | 'blocked' | 'done' | 'failed' | 'running' | 'starting' | 'waiting'

export interface CanonicalEvent {
  eventId: string           // `${source}:${agentType ?? 'unknown'}:${timestamp}:${lineIndex}`
  agentId: string | null    // skeleton/journalのみ保持
  agentType: string | null  // 優先順位は下記参照
  feature: string | null    // 自己申告のみ保持
  startTimestamp: string | null
  endTimestamp: string | null
  status: EventStatus | null
  detail: string | null
  intent: string | null
  scenario: string | null   // loop-observabilityのみ
  source: EventSource
}

export interface CorrelatedExecution {
  agentId: string           // skeleton/journal由来のagentId、無ければ自己申告側の合成eventId
  events: CanonicalEvent[]  // 4ソースの生CanonicalEventをそのまま保持、マージしない
}

export function correlateEvents(events: CanonicalEvent[]): CorrelatedExecution[]
```

### eventIdの一意性

各`log-*.sh`は`date -u +"%Y-%m-%dT%H:%M:%SZ"`（秒精度、ミリ秒無し）でタイムスタンプを書くため、同一秒内に複数の状態遷移が起きるとタイムスタンプだけでは衝突しうる。ログ生成側（bash）は無改修という前提のもと、**ファイル内での出現順インデックス（`lineIndex`、0始まり）をeventIdに含める**ことで一意性を保証する。

### agentTypeの優先順位

`agent()`が`opts.agentType`を指定せずに呼ばれた場合、hookの`agent_type`・journalの`meta.json`の`agentType`は両方とも`"workflow-subagent"`という汎用値になる（下記「実機検証」参照）。したがって`agentType`は**自己申告側（agent-progress/loop-observability）が`extractAgentType`で復元した値を優先し、無ければskeleton/journal側の生値にフォールバック**する。Stage 1（agentId厳密一致）はagentTypeに依存しないため、この優先順位はStage 1のロジックに影響しない。

### correlateEvents()の戻り値の設計判断

突合結果は個々の`CanonicalEvent`を1つにマージせず、`CorrelatedExecution.events`配列として生データのまま保持する。マージ（どのソースのdetailを勝たせるか等）は消費側（`verify-agent-progress-transcript.ts`のレポート生成）の責務とする。理由: マージを`correlateEvents()`内に隠すと、暗黙の優先順位ルールがコードレビューで見えなくなる。生データを保持することで、後段が「どのソースの情報を根拠にレポートしたか」を追跡でき、デバッグ性が高い。

---

## 突合アルゴリズム（2段階アンカー方式）

### Stage 1 — agentId厳密一致（skeleton ⇔ journal）

`subagent-skeleton`は`SubagentStart`/`SubagentStop`の2行を同じ`agentId`で書くため、ペアリング処理は不要。`correlateEvents()`は同一`agentId`を持つイベントを厳密一致でグループ化するだけで、skeletonのStart行・Stop行・journal由来のイベントが自動的に1つの`CorrelatedExecution`にまとまる。

**実機検証済み（2026-07-27）:** Workflowで1エージェントのみのプローブ実行を行い、journal.jsonlの`agentId`(`a86f06bf88161050f`)とhookが書いた`subagent-skeleton.jsonl`の`agent_id`が完全一致することを確認した。

```
journal.jsonl:            {"type":"result","agentId":"a86f06bf88161050f","result":"PROBE_OK"}
subagent-skeleton.jsonl:  {"hookEvent":"SubagentStart","agentId":"a86f06bf88161050f",...}
                           {"hookEvent":"SubagentStop","agentId":"a86f06bf88161050f",
                            "agentTranscriptPath":".../wf_.../agent-a86f06bf88161050f.jsonl",...}
```

同時に、`opts.agentType`未指定時は`agent_type`/`meta.json`の`agentType`が両方とも`"workflow-subagent"`になることも確認した（`meta.json`実体: `{"agentType":"workflow-subagent","spawnDepth":1}`）。これが上記「agentTypeの優先順位」ルールの根拠である。

### Stage 2 — agentTypeの時刻窓フォールバック（agent-progress / loop-observability）

`agentId`を持たない自己申告2ソースは、既存`matchRecords`と同じ方式を踏襲する。

- 対象: `agent-progress`は`status ∈ {done, failed}`の行のみ。`loop-observability`は全行（1 attempt = 1 event）。
- 同一`agentType`を持つアンカー（Stage 1で確定した`CorrelatedExecution`）群の中から、`endTimestamp`が最も近い（かつ30分以内の）ものへ貪欲に割り当てる。30分許容値は既存踏襲（変更の実測根拠が無いため現状維持）。
- 排他制御は「ソース×agentType」単位でスコープする。同じアンカーに`agent-progress`と`loop-observability`の両方が対応付くのは正常（別ソースなので競合しない）。同一ソース内で複数の自己申告行が同じアンカーを奪い合う場合は使用済みアンカーを除外する（既存`usedTranscriptIndexes`と同じ）。
- アンカーに対応するものが見つからない自己申告行（hook導入以前の古いログ等）は、単独の`CorrelatedExecution`（`agentId`は自身の合成`eventId`）としてそのまま返す。既存の`unmatchedSelf`概念はここに吸収される。

**中間状態（running/waiting/starting）の扱い:** `agentProgressAdapter`は`agent-progress.jsonl`の全行を`CanonicalEvent`として出力するが、Stage 2の突合対象は`done`/`failed`のみである。したがって`running`/`waiting`/`starting`の行は常に単独の`CorrelatedExecution`になる。これは新しい制約ではなく、既存`loadSelfReports`が最初からdone/failedのみを検証対象としてきたのを踏襲するだけの意図的な仕様である。

**既知の限界（既存踏襲）:** 高並行実行下で同一`agentType`かつ同一時刻窓に3件以上重なる場合、誤対応の可能性は既存同様残る。これは`docs/agents/observability-internals.md`に既に明記済みの限界であり、今回の統合でも解消しない。

---

## Adapter詳細

```ts
export interface EventAdapter {
  source: EventSource
  load(): CanonicalEvent[]
}
```

| Adapter | 入力 | agentId | agentType | timestamp | status/detail |
|---|---|---|---|---|---|
| `subagentSkeletonAdapter(logFile?)` | `logs/subagent-skeleton.jsonl` | hookの`agent_id`そのまま | hookの`agent_type`生値 | Start行→`startTimestamp`、Stop行→`endTimestamp` | status=null、detail=`lastAssistantMessage` |
| `journalAdapter(projectDir?)` | 既存`loadTranscripts()`（`reconstruct-loop-observability.ts`のjournal優先ロジックを再利用、無改修） | journal/meta.jsonの`agentId` | `meta.json`の`agentType`生値 | endTimestampのみ（transcript解析由来） | journal優先→無ければtranscript解析 |
| `agentProgressAdapter(logFile?)` | `logs/agent-progress.jsonl`全行（新規`loadAllAgentProgressRecords()`。既存`loadSelfReports`はdone/failedのみ抽出していたため別関数にする） | null | `extractAgentType(agent)`（`KNOWN_AGENT_TYPES`を`verify-agent-progress-transcript.ts`から本モジュールへ移設） | 単一timestampを`endTimestamp`に格納 | status=自己申告そのまま、detail=`note` |
| `loopObservabilityAdapter(logFile?)` | `logs/loop-observability.jsonl`全行 | null | `extractAgentType(agent)` | `endTimestamp`のみ | status=`result`、detail=`reason`、intent/scenarioも保持 |

`loadAllEvents(opts?)`が4 Adapterをまとめて呼び、`CanonicalEvent[]`を返す（`correlateEvents()`への入力）。`journalAdapter`のみ`~/.claude/projects/**`のファイルツリー走査を伴うため重い点は既存同様・無改修。

---

## 消費側の移行

`verify-agent-progress-transcript.ts`は以下のパイプラインに書き換える。

```
loadAllEvents() → correlateEvents() → compareStatus/compareDetail（意味変換、verify側に残す）→ buildReport()
```

`matchRecords`/`extractAgentType`/`KNOWN_AGENT_TYPES`は`canonical-event.ts`へ移設する。CLIオプション・出力フォーマット・exit codeは無変更。

---

## テスト計画

### 単体テスト

- `canonical-event.test.ts` — 4 Adapterそれぞれの正規化・`correlateEvents()`のStage1/Stage2ロジック
- `verify-agent-progress-transcript.test.ts` — 意味変換（`compareStatus`/`compareDetail`）・レポート整形のみに縮小

### 等価性テスト

既存gap checkとの対応関係は**ソースごとに性質が異なる**ため、一律の「等価性テスト」ではなく2種類に分けて設計する。

| ソース | 既存bash比較対象 | 検証の性質 |
|---|---|---|
| `loop-observability` | `check-loop-observability-gap.sh`（`wc -l`、全行が対象） | **既存ロジックとの同等性検証**: Adapter出力件数 = 生ファイル`wc -l` |
| `agent-progress` | `check-agent-progress-gap.sh`（`jq`で`status=="done" or "failed"`のみカウント） | ①fidelity検証: Adapter出力件数（全ステータス）= 生ファイル`wc -l`。②**既存ロジックとの同等性検証（本体）**: Adapter出力のうち`status∈{done,failed}`の件数 = 既存`jq`フィルタ件数 |
| `journal` | 無し（`wf_*/`ディレクトリに分散しており対応する単一ファイルの既存gap checkが存在しない） | **Adapter自体の正しさを保証する単体テスト**: 既知件数を仕込んだfixture（`wf_*/journal.jsonl`+`agent-*.jsonl`+`.meta.json`一式）に対し、Adapter出力件数が既知件数と一致することを直接assertする |
| `subagent-skeleton` | 無し | 同上（journalと同じ性質） |

`journal`/`subagent-skeleton`について「同等性テスト」という呼称は使わない。対応する既存bashロジックが無いため、比較対象自体が存在しないからである。

---

## ファイル一覧・ロールアウト順

1. `scripts/lib/canonical-event.ts`（新規）+ `canonical-event.test.ts`
2. `scripts/lib/canonical-event-gap-check-equivalence.test.ts`（新規、上表の①②のみ対象）
3. `scripts/lib/verify-agent-progress-transcript.ts`（リファクタ、CLI/出力互換）
4. `scripts/lib/verify-agent-progress-transcript.test.ts`（テスト再配置）
5. `docs/agents/observability-internals.md`に本統合の設計・実機検証結果を追記

---

## 決定事項サマリ

1. アーキテクチャ: 読み取り専用アダプタ層`canonical-event.ts`を新設。書き込み側・gap check bashは無改修
2. 型: `CanonicalEvent`（1件粒度、`eventId`は`source:agentType:timestamp:lineIndex`）+ `CorrelatedExecution`（グループ化、マージしない）
3. 突合: Stage1（agentId厳密一致、実機検証済み）→ Stage2（agentType＋30分窓の貪欲割当、既存踏襲）
4. Adapter: 4種、共通インターフェース、agentTypeは自己申告側の復元値を優先
5. 等価性テスト: ソースごとに性質が異なる（既存ロジックとの同等性2つ＋Adapter自体の正しさ検証2つ）
