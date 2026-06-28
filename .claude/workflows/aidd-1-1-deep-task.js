export const meta = {
  name: 'aidd-1-1-deep-task',
  description: 'コード深掘り調査 + 仕様書ドラフト生成 + 仕様書深層検証を一気通貫で実行するオンデマンド重火器。',
  whenToUse: 'バグ修正・DBスキーマ変更・高リスク機能など、徹底的に調査・検証したいときに手動で実行する。',
  phases: [
    { title: 'Sweep',               detail: '4軸並列Sweep + Loop Until Dry' },
    { title: 'Completeness Critic', detail: '未調査領域検出' },
    { title: 'Draft Spec',          detail: '調査結果から仕様書ドラフト生成' },
    { title: 'Find',                detail: '仕様書ドラフトへの5軸問題発見' },
    { title: 'Adversarial Verify',  detail: '偽陽性除去' },
    { title: 'Completeness Critic', detail: 'ギャップ検出' },
    { title: 'Judge Panel',         detail: '3案生成・採点' },
    { title: 'Synthesize',          detail: '全結果統合・仕様修正案出力' },
  ],
}

// args: { taskDescription?: string, maxRounds?: number }
// taskDescription: 調査対象・機能の説明（例: 「ローン返却機能の追加」）
//
// ── 完了後の手順（Claude が実行すること）──────────────────────────────
// 1. synthesis の内容を反映して SPEC.md を確定させる
// 2. 【停止①】仕様書を人間に提示し、承認を得るまで Phase 3 に進まない
// ────────────────────────────────────────────────────────────────────

const taskDescription = args?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = args?.maxRounds ?? 3

// ─── Phase 1-2: Sweep + Completeness Critic ──────────────────────────
let round = 1
let dryRounds = 0
const allFindings = { ui: [], data: [], db: [], types: [] }
let additionalContext = ''

while (dryRounds < 2 && round <= maxRounds) {
  log(`Sweepラウンド ${round}/${maxRounds} 開始`)
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

  phase('Completeness Critic')
  const criticResult = await agent(
    `タスク: ${taskDescription}\n\n## 今ラウンドのSweep結果\n${roundSummary}\n\n## 累積発見\nUI: ${allFindings.ui.join('\n')}\nData: ${allFindings.data.join('\n')}\nDB: ${allFindings.db.join('\n')}\nTypes: ${allFindings.types.join('\n')}`,
    { label: `critic:R${round}`, agentType: 'completeness-critic', phase: 'Completeness Critic' }
  )

  const hasNewCriticFindings = criticResult != null && criticResult.includes('追加調査対象:')

  if (!hasNewFindings && !hasNewCriticFindings) {
    dryRounds++
    log(`Dry ラウンド ${dryRounds}/2`)
  } else {
    dryRounds = 0
    additionalContext = hasNewCriticFindings ? criticResult : ''
  }
  round++
}

const sweepSummary = [
  `## UI層\n${allFindings.ui.join('\n') || '指摘なし'}`,
  `## データ取得層\n${allFindings.data.join('\n') || '指摘なし'}`,
  `## DB層\n${allFindings.db.join('\n') || '指摘なし'}`,
  `## 型整合性\n${allFindings.types.join('\n') || '指摘なし'}`,
].join('\n\n')

log(`Sweep完了: ${round - 1}ラウンド`)

// ─── Phase 3: 仕様書ドラフト生成 ──────────────────────────────────────
phase('Draft Spec')

const draftSpec = await agent(
  `以下の調査結果をもとに、機能仕様書ドラフトを生成してください。\n\nタスク: ${taskDescription}\n\n## 調査結果\n${sweepSummary}\n\n## 出力形式\n### Part 1 — 仕様（人間レビュー用）\n- 何ができるようになるか（利用者目線）\n- 操作の流れ・受け入れ条件（チェックリスト）\n\n### Part 2 — 実装計画（AI用）\n- 実装セット一覧（依存順）\n- 各セットのテスト観点・型・データアクセス層の方針\n- 並列グループ宣言（触るファイルを明記）`,
  { label: 'draft-spec', phase: 'Draft Spec', model: 'claude-sonnet-4-6', effort: 'medium' }
)

log('仕様書ドラフト生成完了。Deep Spec 検証を開始します。')

// ─── Phase 4: Find ────────────────────────────────────────────────────
phase('Find')

const FINDING_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title:       { type: 'string' },
          description: { type: 'string' },
          severity:    { type: 'string', enum: ['critical', 'important', 'minor'] },
          category:    { type: 'string' },
        },
        required: ['title', 'description', 'severity', 'category'],
      },
    },
  },
  required: ['findings'],
}

const FINDERS = [
  { lens: 'logic',       prompt: 'ロジック・境界条件・エッジケースの観点で' },
  { lens: 'data',        prompt: 'DBスキーマ・型・データ整合性・マイグレーションリスクの観点で' },
  { lens: 'security',    prompt: 'セキュリティ・認可・RLS・入力検証の観点で' },
  { lens: 'ux',          prompt: 'UX・エラー表示・ローディング・空状態の観点で' },
  { lens: 'performance', prompt: 'パフォーマンス・クエリ効率・N+1・インデックスの観点で' },
]

const findResults = await parallel(
  FINDERS.map(f => () => agent(
    `${f.prompt}、以下の仕様書ドラフトの問題点を列挙せよ。\n\n${draftSpec}`,
    { label: `find:${f.lens}`, phase: 'Find', schema: FINDING_SCHEMA, model: 'claude-haiku-4-5-20251001', effort: 'low' }
  ))
)

const allFindResults = findResults.filter(Boolean).flatMap(r => r.findings)
const seen = new Set()
const dedupedFindings = allFindResults.filter(f => {
  const key = f.title.slice(0, 30)
  if (seen.has(key)) return false
  seen.add(key)
  return true
})
log(`Find完了: ${allFindResults.length}件 → dedup後 ${dedupedFindings.length}件`)

// ─── Phase 5: Adversarial Verify ─────────────────────────────────────
phase('Adversarial Verify')

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason:  { type: 'string' },
  },
  required: ['refuted', 'reason'],
}

const verdicts = await parallel(
  dedupedFindings.map((f, i) => () => agent(
    `次の仕様指摘を反証しようとせよ。仕様書のどこかで既に対処されているか、問題が成立しない理由があれば refuted=true にせよ。不確かなら refuted=true でよい。\n\nタイトル: ${f.title}\n説明: ${f.description}\n\n仕様書ドラフト:\n${draftSpec}`,
    { label: `verify:${i}`, phase: 'Adversarial Verify', schema: VERDICT_SCHEMA, model: 'claude-sonnet-4-6', effort: 'medium' }
  ))
)

const survived = dedupedFindings.filter((_, i) => !verdicts[i]?.refuted)
log(`Adversarial Verify完了: ${dedupedFindings.length}件 → ${survived.length}件生存`)

// ─── Phase 6: Completeness Critic ────────────────────────────────────
phase('Completeness Critic')

const CRITIC_SCHEMA = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          area:        { type: 'string' },
          description: { type: 'string' },
          suggestion:  { type: 'string' },
        },
        required: ['area', 'description', 'suggestion'],
      },
    },
  },
  required: ['gaps'],
}

const criticResult2 = await agent(
  `以下の仕様書ドラフトと生存した指摘リストを見て、まだ検証されていない領域・抜け漏れ・未回答の設計判断を指摘せよ。\n\n## 仕様書ドラフト\n${draftSpec}\n\n## 生存した指摘\n${survived.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n')}`,
  { label: 'completeness-critic-2', phase: 'Completeness Critic', schema: CRITIC_SCHEMA, model: 'claude-sonnet-4-6', effort: 'medium' }
)

const gaps = criticResult2?.gaps ?? []
log(`Completeness Critic完了: ${gaps.length}件のギャップ`)

// ─── Phase 7: Judge Panel ─────────────────────────────────────────────
phase('Judge Panel')

const PROPOSAL_SCHEMA = {
  type: 'object',
  properties: {
    name:         { type: 'string' },
    description:  { type: 'string' },
    keyDecisions: { type: 'array', items: { type: 'string' } },
    tradeoffs:    { type: 'string' },
  },
  required: ['name', 'description', 'keyDecisions', 'tradeoffs'],
}

const SCORE_SCHEMA = {
  type: 'object',
  properties: {
    feasibility:     { type: 'number' },
    safety:          { type: 'number' },
    userValue:       { type: 'number' },
    maintainability: { type: 'number' },
    total:           { type: 'number' },
    comment:         { type: 'string' },
  },
  required: ['feasibility', 'safety', 'userValue', 'maintainability', 'total', 'comment'],
}

const PROPOSERS = [
  { stance: 'MVP優先',    prompt: 'スコープを最小化しつつ最速で価値を届ける設計アプローチを1案提案せよ。' },
  { stance: 'リスク最小', prompt: '技術的・運用的リスクを最小化する保守的な設計アプローチを1案提案せよ。' },
  { stance: '拡張性重視', prompt: '将来の機能拡張・スケールを見越した設計アプローチを1案提案せよ。' },
]

const proposals = await parallel(
  PROPOSERS.map(p => () => agent(
    `${p.prompt}\n\n## 仕様書ドラフト\n${draftSpec}\n\n## 生存した問題点\n${survived.map(f => `- [${f.severity}] ${f.title}`).join('\n')}\n\n## ギャップ\n${gaps.map(g => `- ${g.area}: ${g.description}`).join('\n')}`,
    { label: `propose:${p.stance}`, phase: 'Judge Panel', schema: PROPOSAL_SCHEMA, model: 'claude-sonnet-4-6', effort: 'medium' }
  ))
)

const validProposals = proposals.filter(Boolean)

const scoredProposals = await parallel(
  validProposals.map((proposal, pi) => () =>
    parallel(
      ['correctness', 'security', 'ux'].map(lens => () => agent(
        `次の設計案を「${lens}」の視点で採点せよ（各項目0-100、totalは加重平均）。\n\n## 案名: ${proposal.name}\n${proposal.description}\n\n主要判断:\n${proposal.keyDecisions.join('\n')}\n\nトレードオフ: ${proposal.tradeoffs}`,
        { label: `score:${pi}:${lens}`, phase: 'Judge Panel', schema: SCORE_SCHEMA, model: 'claude-haiku-4-5-20251001', effort: 'low' }
      ))
    ).then(scores => {
      const validScores = scores.filter(Boolean)
      const avgTotal = validScores.reduce((s, sc) => s + sc.total, 0) / (validScores.length || 1)
      return { proposal, scores: validScores, avgScore: avgTotal }
    })
  )
)

const validScored = scoredProposals.filter(Boolean).sort((a, b) => b.avgScore - a.avgScore)
const winner = validScored[0]
const runnerUps = validScored.slice(1)
log(`Judge Panel完了: 最高スコア案 "${winner?.proposal?.name}" (${Math.round(winner?.avgScore ?? 0)}点)`)

// ─── Phase 8: Synthesize ──────────────────────────────────────────────
phase('Synthesize')

const synthesis = await agent(
  `以下の全検証結果を統合して、仕様書ドラフトへの具体的な修正提案を出力せよ。\n\n## 元の仕様書ドラフト\n${draftSpec}\n\n## 生存した問題点 (${survived.length}件)\n${survived.map(f => `- [${f.severity}][${f.category}] ${f.title}: ${f.description}`).join('\n')}\n\n## ギャップ (${gaps.length}件)\n${gaps.map(g => `- [${g.area}] ${g.description} → 提案: ${g.suggestion}`).join('\n')}\n\n## Judge Panel結果\n### 採用推奨案: ${winner?.proposal?.name} (スコア: ${Math.round(winner?.avgScore ?? 0)})\n${winner?.proposal?.description}\n主要判断: ${winner?.proposal?.keyDecisions?.join(' / ')}\n\n### 他案のグラフト候補\n${runnerUps.map(r => `- ${r.proposal?.name}: ${r.proposal?.keyDecisions?.join(' / ')}`).join('\n')}\n\n## 出力形式\n1. **必須修正** (critical/important の問題点)\n2. **推奨修正** (minor・ギャップ)\n3. **設計判断** (採用推奨アプローチとその理由)\n4. **未解決事項** (人間が判断すべきポイント)`,
  { label: 'synthesize', phase: 'Synthesize', model: 'claude-opus-4-8', effort: 'high' }
)

return {
  sweepFindings: allFindings,
  draftSpec,
  survived,
  gaps,
  winner:      winner?.proposal,
  winnerScore: winner?.avgScore,
  synthesis,
}
