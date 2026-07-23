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

// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への回避策
// （.claude/workflows/aidd-phase1-router.js・.claude/workflows/lib/resolve-workflow-args.js
// と同一パターン。issue #399の調査で本ファイルにもガードが無いことが判明した）。
const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
const taskDescription = parsedArgs?.taskDescription ?? '現在のコードベース全体の調査'
const maxRounds = parsedArgs?.maxRounds ?? 3

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

// 正本: .claude/workflows/lib/prompts/sweep.js。Workflow DSLはrequire不可のため
// インライン複製している。同期は sweep-prompt-sync.test.js が検証する（issue #431）。
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

// budgetガード（issue #442）。正本・単体テストは .claude/workflows/lib/budget-guard.js。
// Workflow DSLはrequire不可のためインライン複製している（judge-panel.js等と同一パターン）。
// budget.totalが未設定(null)なら常にfalseを返し、既存動作を完全に維持する（後方互換）。
// 1ラウンドはSweep 4エージェント + Completeness Critic 1エージェント。閾値はissue #442
// 調査時点の実測（軽量Sweep 5エージェントで約28万トークン）に安全マージンを載せた仮置き値。
const MIN_BUDGET_FOR_SWEEP_ROUND = 400_000
function isBudgetExhausted(minRemainingForRound) {
  return Boolean(budget?.total && budget.remaining() < minRemainingForRound)
}
function shouldContinueSweepLoop(dryRounds, round, maxRounds, minRemainingForRound) {
  if (dryRounds >= 2) return false
  if (round > maxRounds) return false
  if (isBudgetExhausted(minRemainingForRound)) return false
  return true
}

// ─── Phase 1-2: Sweep + Completeness Critic ──────────────────────────
let round = 1
let dryRounds = 0
const allFindings = { ui: [], data: [], db: [], types: [] }
// 軸ごとに既出の指摘文言(先頭80文字)を記録し、ラウンドをまたいだ同一指摘の再掲を
// 「新規」として扱わないようにする（issue #293: 再掲が永遠に新規扱いされ収束しない問題）
const seenFindingKeys = { ui: new Set(), data: new Set(), db: new Set(), types: new Set() }
// 直近ラウンドでblocked/未応答（deny-by-default）だった軸。エスカレーション報告に使う
let lastRoundBlockedAxes = []
let additionalContext = ''

while (shouldContinueSweepLoop(dryRounds, round, maxRounds, MIN_BUDGET_FOR_SWEEP_ROUND)) {
  log(`Sweepラウンド ${round}/${maxRounds} 開始`)
  phase('Sweep')

  const sweepPrompt = (additionalContext
    ? `タスク: ${taskDescription}\n\n前ラウンドのCritic追加指示:\n${additionalContext}`
    : `タスク: ${taskDescription}`) + SWEEP_GUIDE

  const [uiResult, dataResult, dbResult, typesResult] = await parallel([
    () => agent(sweepPrompt, { label: `sweep-ui:R${round}`,    agentType: 'sweep-ui',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => agent(sweepPrompt, { label: `sweep-data:R${round}`,  agentType: 'sweep-data',  phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => agent(sweepPrompt, { label: `sweep-db:R${round}`,    agentType: 'sweep-db',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => agent(sweepPrompt, { label: `sweep-types:R${round}`, agentType: 'sweep-types', phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
  ])
  const axisResults = { ui: uiResult, data: dataResult, db: dbResult, types: typesResult }

  // deny-by-default: status==='pass'と確認できない軸（blocked・null・未知の値）はすべてblocked扱いにしてエスカレーションする
  lastRoundBlockedAxes = Object.entries(axisResults)
    .filter(([, r]) => r?.status !== 'pass')
    .map(([axis, r]) => `${axis}(status=${r?.status ?? 'なし'})`)
  if (lastRoundBlockedAxes.length > 0) {
    log(`Sweep警告: ラウンド${round}でblocked/未応答の軸を検知 → ${lastRoundBlockedAxes.join(', ')}`)
  }

  // isNew: 完遂できた(status==='pass')・指摘ありに加え、同一文言を過去ラウンドで既に記録していないことを条件にする(3軸判定)
  const isNew = (axis, r) => {
    if (r?.status !== 'pass' || r?.detail === '指摘なし') return false
    const key = r.detail.trim().slice(0, 80)
    if (seenFindingKeys[axis].has(key)) return false
    seenFindingKeys[axis].add(key)
    return true
  }
  const isNewUi    = isNew('ui', uiResult)
  const isNewData  = isNew('data', dataResult)
  const isNewDb    = isNew('db', dbResult)
  const isNewTypes = isNew('types', typesResult)
  if (isNewUi)    allFindings.ui.push(`[R${round}]\n${uiResult.detail}`)
  if (isNewData)  allFindings.data.push(`[R${round}]\n${dataResult.detail}`)
  if (isNewDb)    allFindings.db.push(`[R${round}]\n${dbResult.detail}`)
  if (isNewTypes) allFindings.types.push(`[R${round}]\n${typesResult.detail}`)

  const hasNewFindings = isNewUi || isNewData || isNewDb || isNewTypes

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

// converged: dryRounds到達（新規指摘が尽きた）による正常終了。falseの場合、ラウンド上限到達か
// budget不足のいずれかによる打ち切りで、未解決の指摘が残っている可能性がある
// （issue #293: 上限到達時も常に「Sweep完了」と報告していた問題。issue #442でbudget切れの
// ケースも同様に一律「ラウンド上限到達」と誤報しないよう区別を追加）
const sweepConverged = dryRounds >= 2
const sweepBudgetExhausted = !sweepConverged && isBudgetExhausted(MIN_BUDGET_FOR_SWEEP_ROUND)
if (sweepConverged) {
  log(`Sweep完了（収束）: ${round - 1}ラウンド`)
} else if (sweepBudgetExhausted) {
  log(`Sweep未完了: budget残高不足のため打ち切り（残り${budget.remaining()}トークン < 閾値${MIN_BUDGET_FOR_SWEEP_ROUND}）。未解決の指摘が残っている可能性があります`)
} else {
  log(`Sweep未完了: ラウンド上限(${maxRounds})に到達したため打ち切り。未解決の指摘が残っている可能性があります`)
}
if (lastRoundBlockedAxes.length > 0) {
  log(`Sweep: 最終ラウンドでblocked/未応答だった軸 → ${lastRoundBlockedAxes.join(', ')}（調査が完遂していない可能性）`)
}

// ─── Phase 3: 仕様書ドラフト生成 ──────────────────────────────────────
phase('Draft Spec')

const draftSpec = await agent(
  `以下の調査結果をもとに、機能仕様書ドラフトを生成してください。\n\nタスク: ${taskDescription}\n\n## 調査結果\n${sweepSummary}\n\n## 出力形式\n### Part 1 — 仕様（人間レビュー用）\n- 何ができるようになるか（利用者目線）\n- 操作の流れ・受け入れ条件（チェックリスト）\n\n### Part 2 — 実装計画（AI用）\n- 実装セット一覧（依存順）\n- 各セットのテスト観点・型・データアクセス層の方針\n- 並列グループ宣言（触るファイルを明記）${''}

## status/detail
上記の仕様書ドラフト本文は detail に格納し、status も返すこと。
- pass: 仕様書ドラフトを生成できた
- fail: 生成されたが調査結果を反映していない等明らかに不完全
- blocked: Sweep結果が空でドラフト生成に着手できなかった`,
  { label: 'draft-spec', phase: 'Draft Spec', model: 'sonnet', effort: 'medium', schema: AGENT_RESULT_SCHEMA_PFB }
)

// 品質ゲート: deny-by-default（.claude/workflows/lib/quality-gate.js shouldBlockと同一発想）。
// これまでdraftSpecのstatusを一切見ずFind以降へ進んでいたため、fail/blockedでも
// 空・矛盾したドラフトを元に後続の調査が無駄に走っていた（issue #293）
if (draftSpec?.status !== 'pass') {
  log(`品質ゲート: Draft Specがstatus="${draftSpec?.status ?? 'なし'}"のため中断（Find以降へは進みません）`)
  return {
    sweepFindings: allFindings,
    sweepConverged,
    sweepBudgetExhausted,
    sweepBlockedAxes: lastRoundBlockedAxes,
    draftSpec,
    blocked: true,
    blockedAt: 'Draft Spec',
  }
}

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
    { label: `find:${f.lens}`, phase: 'Find', schema: FINDING_SCHEMA, model: 'haiku', effort: 'low' }
  ))
)

// issue #432: findingsに発見元のlensをタグ付けする（precision集計をlens別に出すため）。
// findResultsはFINDERSと同じ順序で並列実行されているため、インデックスで対応付けられる。
const allFindResults = findResults
  .map((r, i) => (r?.findings ?? []).map(f => ({ ...f, lens: FINDERS[i].lens })))
  .flat()
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
    { label: `verify:${i}`, phase: 'Adversarial Verify', schema: VERDICT_SCHEMA, model: 'opus', effort: 'medium' }
  ))
)

const survivedFromVerify = toVerify.filter((_, i) => !verdicts[i]?.refuted)
const survived = [...survivedFromVerify, ...autoSurvivedMinor]
log(`Adversarial Verify完了: critical/important ${toVerify.length}件検証 → ${survivedFromVerify.length}件生存（+minor自動生存${autoSurvivedMinor.length}件、計${survived.length}件）`)

// issue #432: Find指摘のAV生存率（Sweep指摘のprecisionではない。理由は
// .claude/workflows/lib/find-av-precision.js のコメント参照）。正本・単体テストは
// .claude/workflows/lib/find-av-precision.js の computeFindAvPrecision。
// Workflow DSLはrequire不可のためインライン複製している（プロンプト文言ではなく
// 集計ロジックのみのため、変更時はfind-av-precision.js側も手動で追従させること）。
function computeFindAvPrecision(dedupedFindings, toVerify, verdicts, autoSurvivedMinor) {
  const survivedFromVerify = toVerify.filter((_, i) => !verdicts[i]?.refuted)
  const survived = [...survivedFromVerify, ...autoSurvivedMinor]
  const byLens = {}
  toVerify.forEach((f, i) => {
    const lens = f?.lens ?? 'unknown'
    byLens[lens] ??= { verified: 0, survived: 0 }
    byLens[lens].verified++
    if (!verdicts[i]?.refuted) byLens[lens].survived++
  })
  return {
    findCount: dedupedFindings.length,
    verifiedCount: toVerify.length,
    survivedCount: survived.length,
    autoSurvivedMinorCount: autoSurvivedMinor.length,
    survivalRate: toVerify.length > 0 ? survivedFromVerify.length / toVerify.length : null,
    byLens,
  }
}
const findAvPrecision = computeFindAvPrecision(dedupedFindings, toVerify, verdicts, autoSurvivedMinor)

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
  { label: 'completeness-critic-2', phase: 'Completeness Critic', schema: CRITIC_SCHEMA, model: 'sonnet', effort: 'medium' }
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
    { label: `propose:${p.stance}`, phase: 'Judge Panel', schema: PROPOSAL_SCHEMA, model: 'sonnet', effort: 'medium' }
  ))
)

const validProposals = proposals.filter(Boolean)

// 設計判断が実質同じ提案しかない場合は採点パネル（3案 x 3観点 = 9エージェント）を省略する。
// 品質ゲート: .claude/workflows/lib/judge-panel.js の computeDivergence と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// 旧実装は正規化文字列の完全一致でしか重複を判定できず、別々のLLM提案が表現違いなだけでも
// 常に「分岐あり」と判定され、不要な採点パネルが起動していた（issue #295）。
// 文字bigramのJaccard類似度に基づくクラスタリングに変更する。
function toBigrams(text) {
  const cleaned = String(text).replace(/\s+/g, '')
  const grams = new Set()
  if (cleaned.length < 2) {
    if (cleaned.length > 0) grams.add(cleaned)
    return grams
  }
  for (let i = 0; i <= cleaned.length - 2; i++) {
    grams.add(cleaned.slice(i, i + 2))
  }
  return grams
}
function decisionSimilarity(a, b) {
  const setA = toBigrams(a)
  const setB = toBigrams(b)
  if (setA.size === 0 && setB.size === 0) return 1
  let intersection = 0
  for (const gram of setA) {
    if (setB.has(gram)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}
const allDecisions = validProposals.flatMap(p => p.keyDecisions)
const clusterRepresentatives = []
for (const decision of allDecisions) {
  const isDuplicate = clusterRepresentatives.some(rep => decisionSimilarity(rep, decision) >= 0.5)
  if (!isDuplicate) clusterRepresentatives.push(decision)
}
const divergenceRatio = allDecisions.length > 0 ? clusterRepresentatives.length / allDecisions.length : 0
const hasDivergence = validProposals.length > 1 && divergenceRatio >= 0.5

let validScored
if (hasDivergence) {
  const scoredProposals = await parallel(
    validProposals.map((proposal, pi) => () =>
      parallel(
        ['correctness', 'security', 'ux'].map(lens => () => agent(
          `次の設計案を「${lens}」の視点で採点せよ（各項目0-100、totalは加重平均）。\n\n## 案名: ${proposal.name}\n${proposal.description}\n\n主要判断:\n${proposal.keyDecisions.join('\n')}\n\nトレードオフ: ${proposal.tradeoffs}`,
          { label: `score:${pi}:${lens}`, phase: 'Judge Panel', schema: SCORE_SCHEMA, model: 'haiku', effort: 'low' }
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
  { label: 'synthesize', phase: 'Synthesize', model: 'opus', effort: 'high', schema: AGENT_RESULT_SCHEMA_PFB }
)

return {
  sweepFindings: allFindings,
  sweepConverged,
  sweepBudgetExhausted,
  sweepBlockedAxes: lastRoundBlockedAxes,
  draftSpec,
  survived,
  gaps,
  winner:      winner?.proposal,
  winnerScore: winner?.avgScore,
  synthesis,
  findAvPrecision,
}
