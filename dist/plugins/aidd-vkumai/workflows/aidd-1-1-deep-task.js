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

// args: { taskDescription?: string, maxRounds?: number, feature?: string }
// taskDescription: 調査対象・機能の説明（例: 「ローン返却機能の追加」）
// feature: 記録（進捗・loop-observability）に使う名前（例: 「issue-809-order-detail」）。
//          英数字と . _ - だけ・64 字まで。未指定や形が違うものは unknown になる（issue #807）
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
- detail: **1行目に必ず \`FINDINGS: <指摘の件数>\` と書く**(例: \`FINDINGS: 2\` / 指摘が無ければ \`FINDINGS: 0\`)。2行目以降に調査結果の本文を書く(指摘が無ければ「指摘なし」と書く)
- 件数は「問題として報告する指摘」の数であって、確認したファイル数ではない。**問題が無かったという報告は 0 件**`

const CRITIC_GUIDE = `

## 出力形式
status と detail を返すこと。
- status: "pass"=批評を完了した(追加調査の要否は問わない) / "blocked"=Sweep結果が空で批評に着手できなかった
- detail: 批評の本文。追加調査が必要な場合は「追加調査対象:」に続けて記述すること`

// ─── 記録漏れ検知のための期待件数（issue #797） ─────────────────────
// WHY: このワークフローは戻り値に stats を持っておらず、**gap check の期待件数を記録できなかった**。
//      CLAUDE.md の「gap check state 記録ルール」は各フェーズ完了後に
//      `record-gap-check-state.sh expected --agent-progress N` を呼べと言うが、
//      N を返す者が居なかったので呼びようがなく、**記録漏れ検知そのものが機能していなかった**。
//      しかも「呼び忘れ」と「呼べない」を区別する手段が無いので、警告が出ないことを
//      「漏れが無い」と読んでしまう（C-025 の型）。
//
// WHY(手で数えずラッパーで数える): aidd-phase2.js は呼び出しの各所で countProgressLoggable() を
//      手で呼んでいるが、この workflow は**ラウンド数と fan-out が動的**（Sweep のラウンド、
//      指摘の件数ぶんの verify、案の数 × 観点の score）で、手で数えると必ずどこかで漏れる。
//      agent() を包んで**呼んだら必ず数える**形にする。包み忘れは
//      scripts/check-workflow-agent-type.test.sh が落とす（issue #791 で全呼び出しに
//      agentType を付けたので、型から機械的に数えられるようになった）。
//
// 一覧は .claude/workflows/lib/agent-progress-expectation.js が正本。Workflow DSL は require が
// 使えないのでインライン複製している。ずれたら中心リポジトリ側の検査
// （進捗記録の指示と一覧を突き合わせるもの。導入先には配っていない）が落とす。
const LOGGABLE_AGENT_TYPES = new Set(['reviewer', 'implementer', 'judge-panel'])
const PROGRESS_LOGGABLE_AGENT_TYPES = new Set([
  'sweep-db', 'sweep-ui', 'sweep-types', 'sweep-data', 'implementer', 'reviewer',
  'integrator', 'judge-panel', 'proposer', 'adversarial-verify', 'completeness-critic', 'contract-writer',
  'spec-drafter',
])
let loggableAgentCount = 0
let progressLoggableAgentCount = 0

// WHY(別名で持つ): このワークフローでは素の `agent(` を書いてはいけない（数から漏れるため）。
//      検査（scripts/lib/scan-workflow-agent-type.mjs --require-wrapper）が素の呼び出しを落とすので、
//      ラッパー自身の中でだけ使う参照は別名にしておく。
const rawAgent = agent

// ─── 記録に使う feature 名（issue #807） ─────────────────────────────
// WHY: このワークフローは feature 名を受け取らず、各エージェントにも渡していなかったので、記録の `--feature` を
//      **各エージェントが自分で作っていた**。2026-09-20 の 1 回の実行（81 体）で 15 種類（`issue-809-order-detail` /
//      `order-detail` / `issue #809` / `order-detail-809` …）になり、feature 別の集計が成り立たない。
//
// WHY(形を絞る): この名前は、エージェントが `--feature "<名前>"` としてシェルへ渡す。引用符・バッククォート・$() を
//      含む名前をそのまま渡すと記録のコマンドが壊れる（か、別のコマンドとして解釈される）。通すのは
//      英数字と . _ - だけ・64 字まで。**形が違う名前は直して通さず unknown に倒す**（直し方を誤って別の名前に
//      化けるより、集計で「名前が渡っていない実行」と分かるほうがよい）。未指定も unknown——各エージェントに
//      名前を作らせない（docs/agents/common.md の「feature 名が与えられていない場合は unknown」と同じ語）
function resolveFeatureName(raw) {
  if (typeof raw !== 'string') return 'unknown'
  return /^[A-Za-z0-9._-]{1,64}$/.test(raw) ? raw : 'unknown'
}
const FEATURE_NAME = resolveFeatureName(parsedArgs?.feature)

function buildFeatureLine(feature) {
  return (
    '\n\n## 記録に使う feature 名\n' +
    `進捗（log-agent-progress.sh）・loop-observability（log-loop-observability.sh）を記録するときは、` +
    `必ず \`--feature "${feature}"\` を使うこと。**自分で名前を作らない**（同じ実行の記録が別々の名前に散って、集計できなくなる）。`
  )
}

/**
 * agent() の代わりに呼ぶ。起動した数をそのまま期待件数として数える。
 *
 * WHY(feature 名をここで足す、issue #807): 全起動がここを通るので、各プロンプトの文面を 1 つずつ書き換えず、
 *      この 1 か所で足す。役を足したときに、足し忘れる道が無い。記録しない役（expectsLogs: false）には足さない。
 *
 * WHY(expectsLogs、issue #807): 期待件数は agentType から決めるが、agentType は**権限のために**付けている
 *      場合がある。木の状態を取るだけの補助役（capture-tree）は、読み取り専用ガードを効かせるために
 *      `reviewer` で起動するが、プロンプトは「2 つのコマンドを実行して結果だけ返せ」で、記録は最初から呼ばない。
 *      2026-09-20 に 2 回の実行を transcript から数えたところ、この 2 体は loop・progress とも 0/2 で、
 *      毎回「記録漏れ 2 件」として gap check に乗っていた。記録しない役は、起動する側が明示して数から外す。
 *      agent() へ渡す opts には足さない（知らないキーを渡さない）ので、別の引数で受ける。
 *      引数を分割代入で書かないのは、テストがこの関数を生テキストで取り出すため
 *      （lib/extract-declaration.js は宣言の最初の波括弧を本体の始まりとして読む）
 */
function trackedAgent(prompt, opts, tracking) {
  const expectsLogs = tracking?.expectsLogs !== false
  const t = opts?.agentType
  if (expectsLogs && LOGGABLE_AGENT_TYPES.has(t)) loggableAgentCount++
  if (expectsLogs && PROGRESS_LOGGABLE_AGENT_TYPES.has(t)) progressLoggableAgentCount++
  return rawAgent(expectsLogs ? prompt + buildFeatureLine(FEATURE_NAME) : prompt, opts)
}

/** 戻り値に載せる stats。早期 return でもここを通す（途中まで起動した分は期待件数に入る） */
const buildStats = (extra = {}) => ({
  phase: 'phase1-deep',
  expectedLoopObservabilityRecords: loggableAgentCount,
  expectedAgentProgressRecords: progressLoggableAgentCount,
  ...extra,
})

// budgetガード（issue #442）。正本・単体テストは .claude/workflows/lib/budget-guard.js。
// Workflow DSLはrequire不可のためインライン複製している（judge-panel.js等と同一パターン）。
// budget.totalが未設定(null)なら常にfalseを返し、既存動作を完全に維持する（後方互換）。
// 1ラウンドはSweep 4エージェント + Completeness Critic 1エージェント。閾値はissue #442
// 調査時点の実測（軽量Sweep 5エージェントで約28万トークン）に安全マージンを載せた仮置き値。
const MIN_BUDGET_FOR_SWEEP_ROUND = 400_000
function isBudgetExhausted(minRemainingForRound) {
  return Boolean(budget?.total && budget.remaining() < minRemainingForRound)
}

// 単発タスクの総量サーキットブレーカー（2026-08-06 mentor評価）。正本・単体テストは
// .claude/workflows/lib/budget-guard.js。Workflow DSLはrequire不可のためインライン複製し、
// 同期は budget-guard-sync.test.js が検証する。budget.total（明示予算）が未設定のときのみ
// DEFAULT_TOKEN_CAPを代替上限として適用し、原因を問わず量で止める。
// 上限値はこのworkflow固有の仮置き値: router-risk.js誤判定インシデント（346万トークン、
// issue #500）を確実に止められ、かつ正常収束時（maxRounds=3のSweep+後続フェーズ）の
// 想定消費を大きく上回る値として2_000_000を選んだ。実測の裏付けは薄く、運用しながら
// 再調整する前提（MIN_BUDGET_FOR_SWEEP_ROUNDと同じ位置づけ）。
const DEFAULT_TOKEN_CAP = 2_000_000
function isDefaultCapExceeded(budget, defaultCap) {
  if (!budget || typeof budget.spent !== 'function') return false
  if (budget.total) return false
  return budget.spent() >= defaultCap
}

function shouldContinueSweepLoop(dryRounds, round, maxRounds, minRemainingForRound) {
  if (dryRounds >= 2) return false
  if (round > maxRounds) return false
  if (isBudgetExhausted(minRemainingForRound)) return false
  if (isDefaultCapExceeded(budget, DEFAULT_TOKEN_CAP)) return false
  return true
}

// ─── Phase 0: 開始時の木の姿を控える（issue #791） ────────────────────
// WHY: このワークフローは**停止①より前**（調査と仕様書ドラフト）で、木を 1 バイトも変えてはいけない。
//      2026-09-18 に、採点役が製品コード 4 ファイルを編集して git commit まで実行した。
//      agentType を全役割に付けて手段を塞いだが、それは「うっかり」を止めるだけで、
//      許可コマンド（bash scripts/*.sh 等）の副作用までは見ていない（check-readonly-bash.sh の限界）。
//      **手段を塞ぐのと、結果を確かめるのは別の防御**なので、終了時に突き合わせる側も置く。
//
// 限界: 取れるのは開始時と終了時の 2 点だけで、途中で変えて戻された場合は分からない。
//       agent() 経由でしか git を呼べない（Workflow DSL にファイル系 API が無い）ため、
//       この 1 体が失敗すると `null` になる——そのときは「確かめられなかった」として扱い、
//       合格にも違反にも数えない（C-025）。
const TREE_STATE_SCHEMA = {
  type: 'object',
  properties: {
    head: { type: 'string' },
    dirty: { type: 'string' },
  },
  required: ['head', 'dirty'],
}
const captureTreeState = (label) =>
  trackedAgent(
    'リポジトリのルートで次の 2 つをそのまま実行し、結果だけを返してください。解釈や要約はしないこと。\n' +
      '1. `git rev-parse HEAD` の出力（コミット SHA）を head に入れる\n' +
      '2. `git status --porcelain` の出力全文を dirty に入れる（変更が無ければ空文字）',
    { label, agentType: 'aidd-core:reviewer', phase: 'Sweep', schema: TREE_STATE_SCHEMA, model: 'haiku', effort: 'low' },
    // WHY: 結果を返すだけの補助役で、記録は呼ばない。reviewer は権限（読み取り専用ガード）のために付けている
    { expectsLogs: false },
  )

const treeBefore = await captureTreeState('capture-tree:before')

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

  // issue #675: sweep-*エージェントに調査範囲を明示する。aidd-1-1-deep-taskはバグ修正・
  // 特定機能の深掘り調査が目的のためfocusedを渡す（正本: lib/prompts/sweep.jsのbuildSweepPrompt）。
  // 全体を漏れなく監査するfullのままだと、taskDescriptionと無関係な指摘（他機能のエラー
  // ハンドリング等）で仕様書ドラフトが埋まってしまう問題があった。
  const SCOPE_LINE_FOCUSED = '\n調査範囲: focused（このタスクに直接関連するファイル・機能のみに絞り込むこと。無関係な全件列挙は不要）'
  const sweepPrompt = (additionalContext
    ? `タスク: ${taskDescription}\n\n前ラウンドのCritic追加指示:\n${additionalContext}`
    : `タスク: ${taskDescription}`) + SCOPE_LINE_FOCUSED + SWEEP_GUIDE

  const [uiResult, dataResult, dbResult, typesResult] = await parallel([
    () => trackedAgent(sweepPrompt, { label: `sweep-ui:R${round}`,    agentType: 'aidd-vkumai:sweep-ui',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => trackedAgent(sweepPrompt, { label: `sweep-data:R${round}`,  agentType: 'aidd-vkumai:sweep-data',  phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => trackedAgent(sweepPrompt, { label: `sweep-db:R${round}`,    agentType: 'aidd-vkumai:sweep-db',    phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
    () => trackedAgent(sweepPrompt, { label: `sweep-types:R${round}`, agentType: 'aidd-vkumai:sweep-types', phase: 'Sweep', schema: AGENT_RESULT_SCHEMA_PB, effort: 'low' }),
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
  const criticResult = await trackedAgent(
    `タスク: ${taskDescription}\n\n## 今ラウンドのSweep結果\n${roundSummary}\n\n## 累積発見\nUI: ${allFindings.ui.join('\n')}\nData: ${allFindings.data.join('\n')}\nDB: ${allFindings.db.join('\n')}\nTypes: ${allFindings.types.join('\n')}${CRITIC_GUIDE}`,
    { label: `critic:R${round}`, agentType: 'aidd-core:completeness-critic', phase: 'Completeness Critic', schema: AGENT_RESULT_SCHEMA_PB }
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
const sweepTokenCapExceeded = !sweepConverged && !sweepBudgetExhausted && isDefaultCapExceeded(budget, DEFAULT_TOKEN_CAP)
if (sweepConverged) {
  log(`Sweep完了（収束）: ${round - 1}ラウンド`)
} else if (sweepBudgetExhausted) {
  log(`Sweep未完了: budget残高不足のため打ち切り（残り${budget.remaining()}トークン < 閾値${MIN_BUDGET_FOR_SWEEP_ROUND}）。未解決の指摘が残っている可能性があります`)
} else if (sweepTokenCapExceeded) {
  log(`Sweep未完了: サーキットブレーカー発動のため打ち切り（累計${budget.spent()}トークン >= デフォルト上限${DEFAULT_TOKEN_CAP}）。未解決の指摘が残っている可能性があります`)
} else {
  log(`Sweep未完了: ラウンド上限(${maxRounds})に到達したため打ち切り。未解決の指摘が残っている可能性があります`)
}
if (lastRoundBlockedAxes.length > 0) {
  log(`Sweep: 最終ラウンドでblocked/未応答だった軸 → ${lastRoundBlockedAxes.join(', ')}（調査が完遂していない可能性）`)
}

// ─── Phase 3: 仕様書ドラフト生成 ──────────────────────────────────────
phase('Draft Spec')

const draftSpec = await trackedAgent(
  `以下の調査結果をもとに、機能仕様書ドラフトを生成してください。\n\nタスク: ${taskDescription}\n\n## 調査結果\n${sweepSummary}\n\n## 出力形式\n### Part 1 — 仕様（人間レビュー用）\n- 何ができるようになるか（利用者目線）\n- 操作の流れ・受け入れ条件（チェックリスト）\n\n### Part 2 — 実装計画（AI用）\n- 実装セット一覧（依存順）\n- 各セットのテスト観点・型・データアクセス層の方針\n- 並列グループ宣言（触るファイルを明記）${''}

## status/detail
上記の仕様書ドラフト本文は detail に格納し、status も返すこと。
- pass: 仕様書ドラフトを生成できた
- fail: 生成されたが調査結果を反映していない等明らかに不完全
- blocked: Sweep結果が空でドラフト生成に着手できなかった`,
  // WHY(agentType、issue #791): 本文は detail で返す設計なので、この役割はファイルを書く必要が無い。
  //      付けないと全ツール持ちになり、実際に SPEC.md を勝手に Write していた（2026-09-18）。
  { label: 'draft-spec', agentType: 'aidd-core:spec-drafter', phase: 'Draft Spec', model: 'sonnet', effort: 'medium', schema: AGENT_RESULT_SCHEMA_PFB }
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
    stats: buildStats(),
  }
}

// サーキットブレーカー: Find以降（Find 5体 → Adversarial Verify(opus×指摘数) → Judge Panel →
// Synthesize）へ進む前にフェーズ境界で累計量を確認する。Sweepループ内のガードだけでは、
// ループ外の後続フェーズが上限超過後もフルに走ってしまう
if (isDefaultCapExceeded(budget, DEFAULT_TOKEN_CAP)) {
  log(`サーキットブレーカー: 累計${budget.spent()}トークンがデフォルト上限${DEFAULT_TOKEN_CAP}を超過したため中断（Find以降へは進みません）`)
  return {
    sweepFindings: allFindings,
    sweepConverged,
    sweepBudgetExhausted,
    sweepBlockedAxes: lastRoundBlockedAxes,
    draftSpec,
    blocked: true,
    blockedAt: 'Token Cap (before Find)',
    tokenCapExceeded: true,
    stats: buildStats(),
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

// WHY(issue #796): deep 9 本の実測で、Find の指摘数は変更の大小に関係なくほぼ一定
//      （38〜71 件、うち critical/important 30〜61 件）で、AV がその 64% を反駁していた。
//      AV は opus で全体の 55% のトークンを使うので、費用の原因は AV ではなく Find のノイズ。
//      AV 側は変えない（検知力を落とさないため）。足すのは「件数を埋めない・根拠を書く・
//      スコープを切る・未確認の推測を格上げしない」だけ。
//
// WHY(3 行目の「ただし」以降を消さない): 1 回目の文言は「既に対処・受容されていれば挙げない」
//      だけで、AV に回る件数は 67→17 に減ったが、当時 AV を生き残った指摘の再現が
//      約 11/17 → 約 5/17 に落ちた（issue #681 の仕様書で security の critical を含む 10 件を失った）。
//      Find が「仕様書に言及がある＝受容済み」と読んで、「未確定」と書かれたままの点と、
//      書かれた検証手段では足りない点まで黙ったため。「ただし」以降を足した 2 回目は
//      67→26（-61%）で、再現は約 12〜13/17（旧と同等以上）。
//
// 限界: 実測は過去 2 本の仕様書 × 各条件 1 回（Haiku）。実行ごとのブレは測っていない。
//      再現の照合は目視。2 回目の文言は 1 回目で失った指摘を見たあとに書いたので、
//      この 2 本に合わせ込んでいる可能性がある。効いているかは logs/find-av-precision.jsonl の
//      次の数本（verifiedCount が 20 前後に下がり、survivedCount が下がらないこと）で確かめる。
const FIND_RULES = [
  '制約:',
  '- 指摘がゼロでもよい。件数を埋めるための指摘はしない（findings は空配列でよい）。',
  '- 各指摘の description に、根拠とした仕様書の該当箇所（見出しまたは引用）を書く。',
  '- 仕様書の他の箇所で具体的な対処が既に決まっている点は挙げない。ただし「書いてある」ことと「それで足りる」ことは別である。「未確定」「未決」「実装時に判断」と書かれているだけの点や、書かれた検証手段では目的を確かめられない点は、対処済みではないので挙げてよい。',
  '- この仕様書が変更する範囲の外にある既存の問題は挙げない。',
  '- 実コードについて断定するなら実際に読んで確かめる。確かめていない推測は critical/important にしない。',
].join('\n')

const findResults = await parallel(
  FINDERS.map(f => () => trackedAgent(
    `${f.prompt}、以下の仕様書ドラフトの問題点を列挙せよ。\n\n${FIND_RULES}\n\n${draftSpec?.detail}`,
    // WHY(agentType、issue #791): 付けないと「既定のワークフロー用サブエージェント」＝**全ツール持ち**
    //      になり、`.claude/agents/*.md` の tools も PreToolUse の読み取り専用ガードも効かない。
    //      ガードは agent_type が空だと素通りする（check-readonly-bash.sh）ので、**一度も発火しなかった**。
    { label: `find:${f.lens}`, agentType: 'aidd-core:reviewer', phase: 'Find', schema: FINDING_SCHEMA, model: 'haiku', effort: 'low' }
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

// サーキットブレーカー: Adversarial Verifyは指摘件数に比例してopusエージェントが起動する
// 最も単価の高いフェーズのため、直前に累計量を再確認する（以降のJudge Panel/Synthesizeは
// 台数上限が固定のためガードは置かない）
if (isDefaultCapExceeded(budget, DEFAULT_TOKEN_CAP)) {
  log(`サーキットブレーカー: 累計${budget.spent()}トークンがデフォルト上限${DEFAULT_TOKEN_CAP}を超過したため中断（Adversarial Verify以降へは進みません）`)
  return {
    sweepFindings: allFindings,
    sweepConverged,
    sweepBudgetExhausted,
    sweepBlockedAxes: lastRoundBlockedAxes,
    draftSpec,
    dedupedFindings,
    blocked: true,
    blockedAt: 'Token Cap (before Adversarial Verify)',
    tokenCapExceeded: true,
    stats: buildStats(),
  }
}

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
  toVerify.map((f, i) => () => trackedAgent(
    `次の仕様指摘を反証しようとせよ。仕様書のどこかで既に対処されているか、問題が成立しない理由があれば refuted=true にせよ。不確かなら refuted=false にせよ（疑わしいものは生存させる）。\n\nタイトル: ${f.title}\n説明: ${f.description}\n\n仕様書ドラフト:\n${draftSpec?.detail}`,
    { label: `verify:${i}`, agentType: 'aidd-core:adversarial-verify', phase: 'Adversarial Verify', schema: VERDICT_SCHEMA, model: 'opus', effort: 'medium' }
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

const criticResult2 = await trackedAgent(
  `以下の仕様書ドラフトと生存した指摘リストを見て、まだ検証されていない領域・抜け漏れ・未回答の設計判断を指摘せよ。\n\n## 仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した指摘\n${survived.map(f => `- [${f.severity}] ${f.title}: ${f.description}`).join('\n')}`,
  { label: 'completeness-critic-2', agentType: 'aidd-core:completeness-critic', phase: 'Completeness Critic', schema: CRITIC_SCHEMA, model: 'sonnet', effort: 'medium' }
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
  PROPOSERS.map(p => () => trackedAgent(
    `${p.prompt}\n\n## 仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した問題点\n${survived.map(f => `- [${f.severity}] ${f.title}`).join('\n')}\n\n## ギャップ\n${gaps.map(g => `- ${g.area}: ${g.description}`).join('\n')}`,
    { label: `propose:${p.stance}`, agentType: 'aidd-core:proposer', phase: 'Judge Panel', schema: PROPOSAL_SCHEMA, model: 'sonnet', effort: 'medium' }
  ))
)

const validProposals = proposals.filter(Boolean)
// issue #521: agent()失敗(null)による間引きは、件数を明示しないと「3案生成」が
// 静かに「1〜2案生成」に減っていることに気づけない（偽の完全性）。
if (validProposals.length < proposals.length) {
  log(`Judge Panel: 提案生成でagent()失敗が${proposals.length - validProposals.length}件あり、${validProposals.length}/${proposals.length}案で続行します`)
}

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
        ['correctness', 'security', 'ux'].map(lens => () => trackedAgent(
          `次の設計案を「${lens}」の視点で採点せよ（各項目0-100、totalは加重平均）。\n\n## 案名: ${proposal.name}\n${proposal.description}\n\n主要判断:\n${proposal.keyDecisions.join('\n')}\n\nトレードオフ: ${proposal.tradeoffs}`,
          // WHY(agentType、issue #791): **この呼び出しが 2026-09-18 の事故の当事者**。
          //      agentType が無いため採点役が全ツールを持ち、「その2経路を直して」という
          //      ユーザー要求に従って製品コード 4 ファイルを編集し git commit まで実行した。
          { label: `score:${pi}:${lens}`, agentType: 'aidd-core:judge-panel', phase: 'Judge Panel', schema: SCORE_SCHEMA, model: 'haiku', effort: 'low' }
        ))
      ).then(scores => {
        const validScores = scores.filter(Boolean)
        if (validScores.length < scores.length) {
          log(`Judge Panel: "${proposal.name}"の採点でagent()失敗が${scores.length - validScores.length}件あり、${validScores.length}/${scores.length}観点の平均で採点します`)
        }
        const avgTotal = validScores.reduce((s, sc) => s + sc.total, 0) / (validScores.length || 1)
        return { proposal, scores: validScores, avgScore: avgTotal }
      })
    )
  )
  const validScoredProposals = scoredProposals.filter(Boolean)
  if (validScoredProposals.length < scoredProposals.length) {
    log(`Judge Panel: 採点処理でagent()失敗が${scoredProposals.length - validScoredProposals.length}件あり、${validScoredProposals.length}/${scoredProposals.length}案で続行します`)
  }
  validScored = validScoredProposals.sort((a, b) => b.avgScore - a.avgScore)
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

const synthesis = await trackedAgent(
  `以下の全検証結果を統合して、仕様書ドラフトへの具体的な修正提案を出力せよ。\n\n## 元の仕様書ドラフト\n${draftSpec?.detail}\n\n## 生存した問題点 (${survived.length}件)\n${survived.map(f => `- [${f.severity}][${f.category}] ${f.title}: ${f.description}`).join('\n')}\n\n## ギャップ (${gaps.length}件)\n${gaps.map(g => `- [${g.area}] ${g.description} → 提案: ${g.suggestion}`).join('\n')}\n\n## Judge Panel結果\n### 採用推奨案: ${winner?.proposal?.name} (スコア: ${Math.round(winner?.avgScore ?? 0)})\n${winner?.proposal?.description}\n主要判断: ${winner?.proposal?.keyDecisions?.join(' / ')}\n\n### 他案のグラフト候補\n${runnerUps.map(r => `- ${r.proposal?.name}: ${r.proposal?.keyDecisions?.join(' / ')}`).join('\n')}\n\n## 出力形式\n1. **必須修正** (critical/important の問題点)\n2. **推奨修正** (minor・ギャップ)\n3. **設計判断** (採用推奨アプローチとその理由)\n4. **未解決事項** (人間が判断すべきポイント)\n\n## status/detail\n上記の統合提案本文は detail に格納し、status も返すこと。\n- pass: 統合提案を生成できた\n- fail: 生成されたが必須修正等のセクションが欠落するなど明らかに不完全\n- blocked: survived/gaps/winnerのいずれかが揃わず統合に着手できなかった`,
  { label: 'synthesize', agentType: 'aidd-core:judge-panel', phase: 'Synthesize', model: 'sonnet', effort: 'high', schema: AGENT_RESULT_SCHEMA_PFB }
)

// ─── 終了時の突き合わせ（issue #791） ────────────────────────────────
// このワークフローは停止①より前なので、木は開始時と同じでなければならない。
const treeAfter = await captureTreeState('capture-tree:after')

let treeGuard
if (!treeBefore || !treeAfter) {
  // WHY(C-025): 「確かめられなかった」を「変わっていない」と読ませない
  treeGuard = { status: 'unknown', reason: '木の姿を控える agent が結果を返さなかったため、比較できていません' }
  log('木の突き合わせ: 確認不能（合格とは読まないこと）')
} else if (treeBefore.head !== treeAfter.head) {
  treeGuard = {
    status: 'violated',
    reason: `停止①より前なのに HEAD が動いています（${treeBefore.head.slice(0, 12)} → ${treeAfter.head.slice(0, 12)}）。いずれかのサブエージェントがコミットしました`,
  }
} else if ((treeBefore.dirty ?? '') !== (treeAfter.dirty ?? '')) {
  treeGuard = {
    status: 'violated',
    reason: `停止①より前なのに作業ツリーが変わっています。\n--- 開始時 ---\n${treeBefore.dirty || '(変更なし)'}\n--- 終了時 ---\n${treeAfter.dirty || '(変更なし)'}`,
  }
} else {
  treeGuard = { status: 'clean', reason: 'HEAD も作業ツリーも開始時のまま' }
}

if (treeGuard.status === 'violated') {
  log(`品質ゲート: ${treeGuard.reason}`)
  return {
    sweepFindings: allFindings,
    sweepConverged,
    draftSpec,
    survived,
    gaps,
    synthesis,
    treeGuard,
    blocked: true,
    blockedAt: 'Tree Guard',
    // 呼び出し元（Claude）への指示。このまま停止①へ進ませない
    nextAction:
      '**このワークフローの成果物をそのまま使わないこと。** 停止①（仕様レビュー）より前に木が変わっています。' +
      '`git log` と `git status` で何が入ったかを確かめ、意図しない変更なら巻き戻してから、人に報告してください（issue #791）。',
    stats: buildStats(),
  }
}

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
  treeGuard,
  stats: buildStats(),
}
