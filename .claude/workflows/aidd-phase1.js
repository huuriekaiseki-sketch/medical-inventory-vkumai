export const meta = {
  name: 'aidd-phase1',
  description: 'Phase 1 調査: 4軸並列Sweep 1ラウンド。新機能追加に向けた既存コード構造の把握。',
  whenToUse: 'フルAIDDフローの Phase 1 調査として使う。SPEC.md生成前に必ず実行。',
  phases: [
    { title: 'Sweep', detail: '4軸並列Sweep（UI/データ/DB/型）— 1ラウンド' },
  ],
}

// args: { taskDescription?: string }
// taskDescription: 追加・実装したい機能の説明（例: 「ローン返却機能の追加」）
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

const taskDescription = args?.taskDescription ?? '現在のコードベース全体の調査'

phase('Sweep')
log('4軸並列Sweep 開始（1ラウンド）')

const sweepPrompt = `タスク: ${taskDescription}`

const [uiResult, dataResult, dbResult, typesResult, baseCommitRaw] = await parallel([
  () => agent(sweepPrompt, { label: 'sweep-ui',    agentType: 'sweep-ui',    phase: 'Sweep' }),
  () => agent(sweepPrompt, { label: 'sweep-data',  agentType: 'sweep-data',  phase: 'Sweep' }),
  () => agent(sweepPrompt, { label: 'sweep-db',    agentType: 'sweep-db',    phase: 'Sweep' }),
  () => agent(sweepPrompt, { label: 'sweep-types', agentType: 'sweep-types', phase: 'Sweep' }),
  () => agent('Run `git rev-parse HEAD` in the repository root and return only the resulting commit SHA, with no other text.', { label: 'capture-base-commit', phase: 'Sweep', effort: 'low' }),
])

log('Sweep 完了')

const baseCommit = baseCommitRaw?.trim().match(/^[0-9a-f]{7,40}$/)?.[0] ?? null
if (!baseCommit) {
  log('警告: baseCommitの取得に失敗しました。Run Manifestのbase_commitは手動で埋めてください。')
}

return {
  findings: {
    ui:    uiResult    ?? '指摘なし',
    data:  dataResult  ?? '指摘なし',
    db:    dbResult    ?? '指摘なし',
    types: typesResult ?? '指摘なし',
  },
  stats: {
    phase: 'phase1',
    agents: 4,
    rounds: 1,
    findingCount: [uiResult, dataResult, dbResult, typesResult]
      .filter(r => r && r !== '指摘なし').length,
  },
  runManifestSeed: {
    baseCommit,
    changedFiles: [],
  },
}
