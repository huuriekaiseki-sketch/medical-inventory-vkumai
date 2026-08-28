export const meta = {
  name: 'aidd-phase1',
  description: 'Phase 1 調査: 4軸並列Sweep 1ラウンド。新機能追加に向けた既存コード構造の把握。',
  whenToUse: 'フルAIDDフローの Phase 1 調査として使う。SPEC.md生成前に必ず実行。',
  phases: [
    { title: 'Sweep', detail: '4軸並列Sweep（UI/データ/DB/型）— 1ラウンド' },
  ],
}

// args: { taskDescription?: string, baseCommit?: string }
// taskDescription: 追加・実装したい機能の説明（例: 「ローン返却機能の追加」）
// baseCommit: 呼び出し側(Claude Code)が`git rev-parse HEAD`で取得したコミットSHAを渡す
//   （`^[0-9a-f]{7,40}$`に一致する場合のみ採用）。渡された場合はcapture-base-commit
//   エージェントの起動自体を省略する(issue #497)。未指定・不正な場合は従来どおり
//   capture-base-commitエージェントを起動してフォールバックする（後方互換）。
//
// ── 完了後の手順（Claude が実行すること）──────────────────────────────
// 1. 調査結果をもとに SPEC.md を生成する
// 2. runManifestSeed.baseCommit と、確定した SPEC.md のパスを使って
//    .aidd/run-manifest.json を Write tool で書き出す
//    （スキーマは docs/agents/run-manifest.md 参照。specHash・approval は
//    停止①で人間が承認した時点で追記する）
// 3. 【停止①】仕様書を人間に提示し、承認を得るまで Phase 3 に進まない
//
// ── 深掘り調査・仕様検証が必要な場合 ────────────────────────────────
// `.claude/workflows/aidd-1-1-deep-task.js` を Read して実行する（オンデマンド）
// ────────────────────────────────────────────────────────────────────
//
// 注記: このワークフロースクリプトはサンドボックス実行のためファイルシステムAPIを
// 持たない。そのためRun Manifestの実ファイル書き出しはスクリプト内では行わず、
// 書き出しに必要な値（baseCommit）だけをここで収集し、返却値経由でオーケストレーター
// に渡す。

// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への回避策
// （.claude/workflows/aidd-phase1-router.js・.claude/workflows/lib/resolve-workflow-args.js
// と同一パターン。issue #399の調査で本ファイルにもガードが無いことが判明した）。
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const taskDescription = parsedArgs?.taskDescription ?? '現在のコードベース全体の調査'

// issue #497: 呼び出し側から渡されたbaseCommitが有効なら、`git rev-parse HEAD`だけのために
// エージェントを1体起動する(capture-base-commit)のを省略する。正規表現は従来の
// baseCommitRawバリデーションと同一のものを流用する。
const BASE_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/
const providedBaseCommit = parsedArgs?.baseCommit?.trim().match(BASE_COMMIT_PATTERN)?.[0] ?? null

// docs/agents/agent-result-schema.md 参照。調査系エージェントに「失敗」概念は無いため pass/blocked の2値
const AGENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

// 正本: .claude/workflows/lib/prompts/sweep.js。Workflow DSLはrequire不可のため
// インライン複製している。同期は sweep-prompt-sync.test.js が検証する（issue #431）。
const STATUS_GUIDE = `

## 出力形式
status と detail を返すこと。
- status: "pass"=調査を最後まで実行できた(指摘の有無は問わない) / "blocked"=権限不足・対象コード不在等で調査自体が実行できなかった
- detail: 調査結果の本文(指摘が無ければ「指摘なし」と書く)`

phase('Sweep')
log('4軸並列Sweep 開始（1ラウンド）')

// issue #675: sweep-*エージェントに調査範囲を明示する。aidd-phase1は新機能追加前の
// 既存コード構造の全体把握が目的のため常にfullを渡す（正本: lib/prompts/sweep.jsのbuildSweepPrompt）。
const SCOPE_LINE_FULL = '\n調査範囲: full（新機能追加に向けた既存コード構造の全体像を把握するため、対象ディレクトリ全体を漏れなく確認すること）'
const sweepPrompt = `タスク: ${taskDescription}${SCOPE_LINE_FULL}${STATUS_GUIDE}`

const sweepAgents = [
  () => agent(sweepPrompt, { label: 'sweep-ui',    agentType: 'sweep-ui',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA, effort: 'low' }),
  () => agent(sweepPrompt, { label: 'sweep-data',  agentType: 'sweep-data',  phase: 'Sweep', schema: AGENT_RESULT_SCHEMA, effort: 'low' }),
  () => agent(sweepPrompt, { label: 'sweep-db',    agentType: 'sweep-db',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA, effort: 'low' }),
  () => agent(sweepPrompt, { label: 'sweep-types', agentType: 'sweep-types', phase: 'Sweep', schema: AGENT_RESULT_SCHEMA, effort: 'low' }),
]
// providedBaseCommitが無い(未指定・不正)場合のみ、フォールバックとしてcapture-base-commit
// エージェントを追加起動する。
if (!providedBaseCommit) {
  sweepAgents.push(() => agent('Run `git rev-parse HEAD` in the repository root and return only the resulting commit SHA, with no other text.', { label: 'capture-base-commit', phase: 'Sweep', effort: 'low' }))
}

const [uiResult, dataResult, dbResult, typesResult, baseCommitRaw] = await parallel(sweepAgents)

log('Sweep 完了')

const results = [uiResult, dataResult, dbResult, typesResult]

// 正本: .claude/workflows/lib/phase1-result-classification.js。Workflow DSLはrequire不可のため
// インライン複製している。同期は phase1-result-classification-sync.test.js が検証する（issue #521）。
function describeSweepResult(result) {
  if (result === null) return '(実行失敗: エージェントが結果を返しませんでした。手動で再実行してください)'
  return result.detail ?? '指摘なし'
}

function classifyPhase1Results(results) {
  return {
    findingCount: results.filter(r => r?.status === 'pass' && r?.detail !== '指摘なし').length,
    blockedCount: results.filter(r => r?.status === 'blocked').length,
    failedCount:  results.filter(r => r === null).length,
  }
}

const { findingCount, blockedCount, failedCount } = classifyPhase1Results(results)

// issue #521: 4体全てがagent()自体の失敗(null。致命的APIエラー等でstatus/detailを
// 自己申告できなかったケース。agent自身が返すstatus:'blocked'とは別物)だった場合、
// findingsを「指摘なし」で埋めた偽の正常完了を返さないよう明示的に中断する。
if (failedCount === results.length) {
  throw new Error('Sweep全4体(ui/data/db/types)がagent()の実行失敗(null)を返しました。findingCount: 0の偽の正常完了を返さないため中断します。手動で再実行してください。')
}
if (failedCount > 0) {
  log(`警告: Sweep ${failedCount}件の軸でagent()自体が実行失敗しました(status/detailを自己申告できず)。該当軸のfindingsは「実行失敗」と表示されます`)
}

const baseCommit = providedBaseCommit ?? (baseCommitRaw?.trim().match(BASE_COMMIT_PATTERN)?.[0] ?? null)
if (!baseCommit) {
  log('警告: baseCommitの取得に失敗しました。Run Manifestのbase_commitは手動で埋めてください。')
}

return {
  findings: {
    ui:    describeSweepResult(uiResult),
    data:  describeSweepResult(dataResult),
    db:    describeSweepResult(dbResult),
    types: describeSweepResult(typesResult),
  },
  stats: {
    phase: 'phase1',
    agents: 4,
    rounds: 1,
    // findingCount: 完遂できた調査のうち、実際に指摘が見つかった本数(status/detailの2軸判定。docs/agents/agent-result-schema.md参照)
    findingCount,
    blockedCount,
    // failedCount: agent()自体が実行失敗しnullを返した軸の数(issue #521)。blockedCount
    // (エージェント自身がstatus:'blocked'を自己申告した数)とは別カウント
    failedCount,
    // issue #339: sweep-ui/data/db/typesの4体は全てdocs/agents/common.md「サブエージェント進捗の
    // 可視化」の進捗記録対象agentType（.claude/workflows/lib/agent-progress-expectation.js参照）。
    // capture-base-commitは対象外のため含めない。
    expectedAgentProgressRecords: 4,
  },
  runManifestSeed: {
    baseCommit,
    changedFiles: [],
  },
}
