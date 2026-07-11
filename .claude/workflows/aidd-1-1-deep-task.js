export const meta = {
  name: 'aidd-1-1-deep-task',
  description: 'コード深掘り調査 + 仕様書ドラフト生成 + 仕様書深層検証を一気通貫で実行するオンデマンド重火器。',
  whenToUse: 'バグ修正・DBスキーマ変更・高リスク機能など、徹底的に調査・検証したいときに手動で実行する。',
  phases: [
    { title: 'Sweep',               detail: '4軸並列Sweep + Loop Until Dry' },
    { title: 'Completeness Critic', detail: '未調査領域検出' },
    { title: 'Draft Spec',          detail: '調査結果から仕様書ドラフト生成' },
    { title: 'Find',                detail: '仕様書ドラフトへの5軸問題発見' },
    { title: 'Adversarial Verify',  detail: '偽陽性除去（critical/importantのみ）' },
    { title: 'Completeness Critic', detail: 'ギャップ検出' },
    { title: 'Judge Panel',         detail: '3案生成・分岐時のみ採点' },
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

// docs/agents/agent-result-schema.md 参照
const AGENT_RESULT_SCHEMA_PB = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const AGENT_RESULT_SCHEMA_PFB = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const SWEEP_GUIDE = `

## 出力形式
status と detail を返すこと。
- status: "pass"=調査を最後まで実行できた(指摘の有無は問わない) / "blocked"=権限不足・対象コード不在等で調査自体が実行できなかった
- detail: 調査結果の本文(指摘が無ければ「指摘なし」と書く)`

const CRITIC_GUIDE = `

## 出力形式
status と detail を返すこと。
- status: "pass"=批評を完了した(追加調査の要否は問わない) / "blocked"=Sweep結果が空で批評に着手できなかった
- detail: 批評の本文。追加調査が必要な場合は「追加調査対象:」に続けて記述すること`

// ─── Phase 1-2: Sweep + Completeness Critic ──────────────────────────
let round = 1
let dryRounds = 0
const allFindings = { ui: [], data: [], db: [], types: [] }
let additionalContext = ''

while (dryRounds < 2 && round <= maxRounds) {
  log(`Sweepラウンド ${round}/${maxRounds} 開始`)
  phase('Sweep')

  const sweepPrompt = (additionalContext
    ? `タスク: ${taskDescription}\n\n前ラウンドのCritic追加指示:\n${additionalContext}`
    : `タスク: ${taskDescription}`) + SWEEP_GUIDE

  const [uiResult, dataResult, dbResult, typesResult] = await parallel([
    () => agent(sweepPrompt, { label: `sweep-ui:R${round}`,    agentType: 'sweep-ui',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB }),
    () => agent(sweepPrompt, { label: `sweep-data:R${round}`,  agentType: 'sweep-data',  phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB }),
    () => agent(sweepPrompt, { label: `sweep-db:R${round}`,    agentType: 'sweep-db',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB }),
    () => agent(sweepPrompt, { label: `sweep-types:R${round}`, agentType: 'sweep-types', phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB }),
  ])

  // isNew: 完遂できた(status==='pass')うえで、実際に新規の指摘がある(detail!=='指摘なし')場合のみ新規findingsとみなす(2軸判定)
  const isNew = (r) => r?.status === 'pass' && r?.detail !== '指摘なし'
  if (isNew(uiResult))    allFindings.ui.push(`[R${round}]\n${uiResult.detail}`)
  if (isNew(dataResult))  allFindings.data.push(`[R${round}]\n${dataResult.detail}`)
  if (isNew(dbResult))    allFindings.db.push(`[R${round}]\n${dbResult.detail}`)
  if (isNew(typesResult)) allFindings.types.push(`[R${round}]\n${typesResult.detail}`)

  const hasNewFindings = isNew(uiResult) || isNew(dataResult) || isNew(dbResult) || isNew(typesResult)

  const roundSummary = [
    `## UI層\n${uiResult?.detail ?? '指摘なし'}`,
    `## データ取得層\n${dataResult?.detail ?? '指摘なし'}`,
    `## DB層\n${dbResult?.detail ?? '指摘なし'}`,
    `## 型整合性\n${typesResult?.detail ?? '指摘なし'}`,
  ].join('\n\n')

  phase('Completeness Critic')
  const criticResult = await agent(
    `タスク: ${taskDescription}\n\n## 今ラウンドのSweep結果\n${roundSummary}\n\n## 累積発見\nUI: ${allFindings.ui.join('\n')}\nData: ${allFindings.data.join('\n')}\nDB: ${allFindings.db.join('\n')}\nTypes: ${allFindings.types.join('\n')}${CRITIC_GUIDE}`,
    { label: `critic:R${round}`, agentType: 'completeness-critic', phase: 'Completeness Critic', schema: AGENT_RESULT_SCHEMA_PB }
  )

  // hasNewCriticFindings: 完遂できた(status==='pass')うえで、detail内に「追加調査対象:」の記述がある場合のみ継続トリガーとする(2軸判定)
  const hasNewCriticFindings = criticResult?.status === 'pass' && criticResult.detail?.includes('追加調査対象:')

  if (!hasNewFindings && !hasNewCriticFindings) {
    dryRounds++
    log(`Dry ラウンド ${dryRounds}/2`)
  } else {
    dryRounds = 0
    additionalContext = hasNewCriticFindings ? criticResult.detail : ''
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
  `以下の調査結果をもとに、機能仕様書ドラフトを生成してください。\n\nタスク: ${taskDescription}\n\n## 調査結果\n${sweepSummary}\n\n## 出力形式\n### Part 1 — 仕様（人間レビュー用）\n- 何ができるようになるか（利用者目線）\n- 操作の流れ・受け入れ条件（チェックリスト）\n\n### Part 2 — 実装計画（AI用）\n- 実装セット一覧（依存順）\n- 各セットのテスト観点・型・データアクセス層の方針\n- 並列グループ宣言（触るファイルを明記）${''}

## status/detail
上記の仕様書ドラフト本文は detail に格納し、status も返すこと。
- pass: 仕様書ドラフトを生成できた
- fail: 生成されたが調査結果を反映していない等明らかに不完全
- blocked: Sweep結果が空でドラフト生成に着手できなかった`,
  { label: 'draft-spec', phase: 'Draft Spec', model: 'claude-sonnet-4-6', effort: 'medium', schema: AGENT_RESULT_SCHEMA_PFB }
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
    `${f.prompt}、以下の仕様書ドラフトの問題点を列挙せよ。\n\n${draftSpec?.detail}`,
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

const toVerify = dedupedFindings.filter(f => f.severity !== 'minor')
const autoSurvivedMinor = dedupedFindings.filter(f => f.severity === 'minor')
if (autoSurvivedMinor.length > 0) {
  log(`Adversarial Verify: minor ${autoSurvivedMinor.length}件はcritical/important対象外のためverifyせず生存扱い`)
}

const verdicts = await parallel(
  toVerify.map((f, i) => () => agent(
    `次の仕様指摘を反証しようとせよ。仕様書のどこかで既に対処されているか、問題が成立しない理由があれば refuted=true にせよ。不確かなら refuted=false にせよ（疑わしいものは生存させる）。\n\nタイトル: ${f.title}\n説明: ${f.description}\n\n仕様書ドラフト:\n${draftSpec?.detail}`,
    { label: `verify:${i}`, phase: 'Adversarial Verify', schema: VERDICT_SCHEMA, model: 'claude-opus-4-8', effort: 'medium' }
  ))
)

const survivedFromVerify = toVerify.filter((_, i) => !verdicts[i]?.refuted)
const survived = [...survivedFromVerify, ...autoSurvivedMinor]
log(`Adversarial Verify完了: critical/important ${toVerify.length}件検証 → ${survivedFromVerify.length}件生存（+minor自動生存${autoSurvivedMinor.length}件、計${survived.length}件）`)

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
  `以下の仕様書ドラフトと生存した指摘リストを見て、まだ検証されていない領域・抜け漏れ・未回答の設計判断を指摘せよ。\n\n## 仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した指摘\n${survived.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n')}`,
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
    `${p.prompt}\n\n## 仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した問題点\n${survived.map(f => `- [${f.severity}] ${f.title}`).join('\n')}\n\n## ギャップ\n${gaps.map(g => `- ${g.area}: ${g.description}`).join('\n')}`,
    { label: `propose:${p.stance}`, phase: 'Judge Panel', schema: PROPOSAL_SCHEMA, model: 'claude-sonnet-4-6', effort: 'medium' }
  ))
)

const validProposals = proposals.filter(Boolean)

// 設計判断が実質同じ提案しかない場合は採点パネル（3案 x 3観点 = 9エージェント）を省略する。
// 正規化したkeyDecisionsの重複率が高い（=判断が割れていない）ほど採点の価値が低いため。
const normalizeDecision = (d) => d.trim().toLowerCase()
const allDecisions = validProposals.flatMap(p => p.keyDecisions.map(normalizeDecision))
const uniqueDecisions = new Set(allDecisions)
const divergenceRatio = allDecisions.length > 0 ? uniqueDecisions.size / allDecisions.length : 0
const hasDivergence = validProposals.length > 1 && divergenceRatio >= 0.5

let validScored
if (hasDivergence) {
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
  validScored = scoredProposals.filter(Boolean).sort((a, b) => b.avgScore - a.avgScore)
  log(`Judge Panel: 設計判断の分岐を検出（重複率${Math.round(divergenceRatio * 100)}%）→ 採点パネルを実行`)
} else {
  validScored = validProposals.map(proposal => ({ proposal, scores: [], avgScore: null }))
  log(`Judge Panel: 設計判断がほぼ一致（重複率${Math.round(divergenceRatio * 100)}%）→ 採点パネルを省略し先頭案を採用`)
}

const winner = validScored[0]
const runnerUps = validScored.slice(1)
log(`Judge Panel完了: 最高スコア案 "${winner?.proposal?.name}" (${winner?.avgScore != null ? Math.round(winner.avgScore) + '点' : '採点省略'})`)

// ─── Phase 8: Synthesize ──────────────────────────────────────────────
phase('Synthesize')

const synthesis = await agent(
  `以下の全検証結果を統合して、仕様書ドラフトへの具体的な修正提案を出力せよ。\n\n## 元の仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した問題点 (${survived.length}件)\n${survived.map(f => `- [${f.severity}][${f.category}] ${f.title}: ${f.description}`).join('\n')}\n\n## ギャップ (${gaps.length}件)\n${gaps.map(g => `- [${g.area}] ${g.description} → 提案: ${g.suggestion}`).join('\n')}\n\n## Judge Panel結果\n### 採用推奨案: ${winner?.proposal?.name} (スコア: ${Math.round(winner?.avgScore ?? 0)})\n${winner?.proposal?.description}\n主要判断: ${winner?.proposal?.keyDecisions?.join(' / ')}\n\n### 他案のグラフト候補\n${runnerUps.map(r => `- ${r.proposal?.name}: ${r.proposal?.keyDecisions?.join(' / ')}`).join('\n')}\n\n## 出力形式\n1. **必須修正** (critical/important の問題点)\n2. **推奨修正** (minor・ギャップ)\n3. **設計判断** (採用推奨アプローチとその理由)\n4. **未解決事項** (人間が判断すべきポイント)\n\n## status/detail\n上記の統合提案本文は detail に格納し、status も返すこと。\n- pass: 統合提案を生成できた\n- fail: 生成されたが必須修正等のセクションが欠落するなど明らかに不完全\n- blocked: survived/gaps/winnerのいずれかが揃わず統合に着手できなかった`,
  { label: 'synthesize', phase: 'Synthesize', model: 'claude-opus-4-8', effort: 'high', schema: AGENT_RESULT_SCHEMA_PFB }
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
