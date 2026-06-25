export const meta = {
  name: 'aidd-phase1',
  description: 'Phase 1 調査: 4軸並列Sweep + Loop Until Dry + Completeness Critic。調査結果を返す。',
  whenToUse: 'フルAIDDフローの Phase 1 調査として使う。SPEC.md生成前に必ず実行。',
  phases: [
    { title: 'Sweep',               detail: '4軸並列Sweep（UI/データ/DB/型）' },
    { title: 'Completeness Critic', detail: '未調査領域の検出・ラウンド終了判定' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number }
// taskDescription: 調査対象タスクの説明（例: 「ローン返却機能の追加」）
const taskDescription = args?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = args?.maxRounds ?? 3

let round = 1
let dryRounds = 0
const allFindings = { ui: [], data: [], db: [], types: [] }
let additionalContext = ''

while (dryRounds < 2 && round <= maxRounds) {
  log(`ラウンド ${round}/${maxRounds} 開始`)
  phase('Sweep')

  const sweepPrompt = additionalContext
    ? `タスク: ${taskDescription}\n\n前ラウンドのCritic追加指示:\n${additionalContext}`
    : `タスク: ${taskDescription}`

  const [uiResult, dataResult, dbResult, typesResult] = await parallel([
    () => agent(sweepPrompt, { label: `sweep-ui:R${round}`,    agentType: 'sweep-ui',    phase: 'Sweep' }),
    () => agent(sweepPrompt, { label: `sweep-data:R${round}`,  agentType: 'sweep-data',  phase: 'Sweep' }),
    () => agent(sweepPrompt, { label: `sweep-db:R${round}`,    agentType: 'sweep-db',    phase: 'Sweep' }),
    () => agent(sweepPrompt, { label: `sweep-types:R${round}`, agentType: 'sweep-types', phase: 'Sweep' }),
  ])

  // 新規発見を累積（「指摘なし」は除外）
  const isNew = (r) => r && r.trim() !== '指摘なし'
  if (isNew(uiResult))    allFindings.ui.push(`[R${round}]\n${uiResult}`)
  if (isNew(dataResult))  allFindings.data.push(`[R${round}]\n${dataResult}`)
  if (isNew(dbResult))    allFindings.db.push(`[R${round}]\n${dbResult}`)
  if (isNew(typesResult)) allFindings.types.push(`[R${round}]\n${typesResult}`)

  const hasNewFindings = isNew(uiResult) || isNew(dataResult) || isNew(dbResult) || isNew(typesResult)

  const roundSummary = [
    `## UI層\n${uiResult ?? '指摘なし'}`,
    `## データ取得層\n${dataResult ?? '指摘なし'}`,
    `## DB層\n${dbResult ?? '指摘なし'}`,
    `## 型整合性\n${typesResult ?? '指摘なし'}`,
  ].join('\n\n')

  // Completeness Critic
  phase('Completeness Critic')
  const criticResult = await agent(
    `タスク: ${taskDescription}\n\n## 今ラウンドのSweep結果\n${roundSummary}\n\n## 累積発見\nUI: ${allFindings.ui.join('\n')}\nData: ${allFindings.data.join('\n')}\nDB: ${allFindings.db.join('\n')}\nTypes: ${allFindings.types.join('\n')}`,
    { label: `critic:R${round}`, agentType: 'completeness-critic', phase: 'Completeness Critic' }
  )

  // 陽性チェック: 「追加調査対象:」が含まれる場合のみ新規指摘あり
  const hasNewCriticFindings = criticResult != null && criticResult.includes('追加調査対象:')

  if (!hasNewFindings && !hasNewCriticFindings) {
    dryRounds++
    log(`Dry ラウンド ${dryRounds}/2（新規発見なし）`)
  } else {
    dryRounds = 0
    additionalContext = hasNewCriticFindings ? criticResult : ''
  }

  round++
}

const total = allFindings.ui.length + allFindings.data.length + allFindings.db.length + allFindings.types.length
log(`調査完了: ${round - 1}ラウンド実行 / 合計${total}件（UI:${allFindings.ui.length} / Data:${allFindings.data.length} / DB:${allFindings.db.length} / Types:${allFindings.types.length}）`)

return {
  findings: allFindings,
  rounds: round - 1,
  summary: {
    ui:    allFindings.ui.length,
    data:  allFindings.data.length,
    db:    allFindings.db.length,
    types: allFindings.types.length,
    total,
  },
}
