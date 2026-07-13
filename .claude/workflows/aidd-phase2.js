export const meta = {
  name: 'aidd-phase2',
  description: 'Phase 3-5: contract-first並列実装 → 統合ゲート → 4観点並列検証。仕様書承認後（停止①の後）に実行。',
  whenToUse: '人間が仕様書（SPEC.md）を承認した後、Phase 3 実装に入るときに使う。aidd-1-1-deep-task.jsの後続として使う。',
  phases: [
    { title: 'Manifest Check', detail: 'Run Manifestのspecハッシュ突合（レビュー後のSPEC.md改変を検知）' },
    { title: 'Contract + DB', detail: 'contract-writer（型定義）とdb-impl（migrations）を並列実行' },
    { title: 'Implement',     detail: 'data-impl / api-impl / ui-impl を並列実行' },
    { title: 'Integrate',     detail: '統合ゲート：マイグレーション確認・結線・テスト・lint' },
    { title: 'Review',        detail: '4観点並列reviewer（読み取り専用）' },
  ],
}

// args: { specPath: string }
// specPath: 承認済みSPEC.mdのパス（例: "SPEC.md"。feature-specスキルはリポジトリルートに出力する）
//
// ── 前提条件（呼び出し前に人間が確認すること）──────────────────────────
// 1. SPEC.md Part 2 に以下が明記されていること
//    - 実装セット一覧（依存順）
//    - 並列グループ宣言（触るファイルを明記）
//    - data-impl が提供する関数名・シグネチャ（api-impl が参照する）
// 2. 停止①（人間承認）が完了していること
//
// ── 完了後の手順（Claude が実行すること）──────────────────────────────
// 1. 【停止②】ユーザーに /structured-review の実行を促して停止する
//    （structured-review は Claude から勝手に呼ばない）
// ────────────────────────────────────────────────────────────────────

const specPath = args?.specPath ?? 'SPEC.md'

// docs/agents/agent-result-schema.md 参照。実装/統合/レビュー系はpass/fail/blockedの3値。
// findingsはfail時の重大度分類（severity.js参照）。Sweep/Draft/Adversarial Verify
// （aidd-1-1-deep-task.js FINDING_SCHEMA）と同じcritical/important/minorを使い、
// 実装後ゲート（Contract+DB/Implement/Integrate/Review）にも重大度の概念を展開する。
const AGENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    detail: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['critical', 'important', 'minor'] },
          description: { type: 'string' },
        },
        required: ['severity', 'description'],
      },
    },
  },
  required: ['status', 'detail'],
}

// 重大度判定（.claude/workflows/lib/severity.js の isMinorOnlyFailure と同一発想）。
// Workflow DSLはrequire不可のためインライン複製している。ロジックの正本・テストはlib側。
function isMinorOnlyFailure(result) {
  if (result?.status !== 'fail') return false
  if (!Array.isArray(result.findings) || result.findings.length === 0) return false
  return result.findings.every(f => f?.severity === 'minor')
}

function shouldBlock(results) {
  if (results.length === 0) return false
  return !results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}

// ログ記録漏れ検知（.claude/workflows/lib/loop-observability-expectation.js の
// isLoggableAgentType と同一ロジック。Workflow DSLはrequire不可のためインライン複製）。
// reviewer/implementer/judge-panelのみ scripts/log-loop-observability.sh 呼び出し指示を
// システムプロンプトに持つ（.claude/agents/*.md参照）。この件数を「期待される記録件数」として
// 返し、フロー完了後に scripts/check-loop-observability-gap.sh で実際のログ行数と突き合わせる。
const LOGGABLE_AGENT_TYPES = new Set(['reviewer', 'implementer', 'judge-panel'])
let loggableAgentCount = 0
function countLoggable(agentType) {
  if (LOGGABLE_AGENT_TYPES.has(agentType)) loggableAgentCount++
}

function logMinorOnlyPassThrough(label, results) {
  const minorOnly = results.filter(isMinorOnlyFailure)
  if (minorOnly.length > 0) {
    log(`品質ゲート: ${label}でminor指摘のみのfailが${minorOnly.length}件あったが通過扱い（critical/important指摘なし）`)
  }
}

const guide = (pass, fail, blocked) => `

## 出力形式
status と detail を返すこと。
- pass: ${pass}
- fail: ${fail}
- blocked: ${blocked}

failの場合はfindings配列（{ severity: critical/important/minor, description }）で指摘ごとに
重大度を明記すること。findings全件がminorならこのゲートは通過扱いになる。
findingsを省略した場合、またはcritical/important指摘が1件でもあれば差し戻し対象になる
（severity不明・欠損はcritical扱い。fail-open防止）。`

// ─── Phase 0: Manifest Check ─────────────────────────────────────────
// issue #44/#294: docs/agents/run-manifest.md にPhase 2開始時のspecHash突合が
// 設計として定義されているが、実行コードには存在しなかった。レビュー後にSPEC.mdが
// 改変されるケースを検知できないまま実装が進んでしまう。
// Workflow DSL自体はfilesystem/Node.js APIアクセスが無いため、Read/Bashツールを持つ
// エージェントにマニフェスト読み込み・ハッシュ再計算・突合を行わせる。
phase('Manifest Check')

const MANIFEST_CHECK_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const manifestCheck = await agent(
  `.aidd/run-manifest.json を Read ツールで読んでください（docs/agents/run-manifest.md にスキーマの説明があります）。\n\n以下を順に確認してください。\n1. .aidd/run-manifest.json が存在しない → blocked。detailに「Run Manifestが存在しません」と書く。\n2. manifest.approval（approvedBy/approvedAt）が無い → blocked。detailに「停止①の承認が記録されていません」と書く。\n3. manifest.specHash が無い → blocked。detailに「specHashが記録されていません」と書く。\n4. 上記が揃っていれば、${specPath} の現在の内容からsha256ハッシュを計算し（Bashツールで shasum -a 256 ${specPath} 等を使ってよい）、manifest.specHash と比較する。\n   - 一致すれば pass。detailに「specHash一致（承認後にSPEC.mdの変更なし）」と書く。\n   - 不一致であれば blocked。detailに「specHash不一致: レビュー承認後にSPEC.mdが変更された可能性があります（manifestの値と実際の値の両方を明記）」と書く。${guide(
    'specHashが一致し、承認記録も揃っている',
    '（未使用: このエージェントはpass/blockedの2値のみ返す）',
    'manifestが存在しない、承認記録が無い、またはspecHashが不一致'
  )}`,
  { label: 'manifest-check', phase: 'Manifest Check', agentType: 'reviewer', schema: MANIFEST_CHECK_SCHEMA }
)

countLoggable('reviewer')
log(`Manifest Check完了: status=${manifestCheck?.status ?? 'なし'}`)

// 品質ゲート: deny-by-default（.claude/workflows/lib/quality-gate.js shouldBlockと同一発想）
if (manifestCheck?.status !== 'pass') {
  log(`品質ゲート: Run Manifestのspec Hash突合に失敗したため中断（${manifestCheck?.detail ?? '詳細不明'}）`)
  return {
    done: false,
    manifestCheck,
    blocked: true,
    blockedAt: 'Manifest Check',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Manifest Check', expectedLoopObservabilityRecords: loggableAgentCount },
  }
}

// ─── Phase A: Contract Write + DB（並列）─────────────────────────────
// contract-writer: src/types/ の型定義を確定（implementerの「契約」）
// db-impl: supabase/migrations/ を実装（SPEC.mdから直接、contract-writerと並行）
phase('Contract + DB')

const [contractResult, dbResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに src/types/ の型定義・APIインターフェース型を確定させてください。${guide(
      '型定義・APIインターフェース型を確定できた',
      '型定義を試みたが不完全・矛盾がある',
      'SPEC.mdが存在しない/読めない'
    )}`,
    { label: 'contract-writer', phase: 'Contract + DB', agentType: 'contract-writer', schema: AGENT_RESULT_SCHEMA }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。${guide(
      'マイグレーション実装が完了した',
      'マイグレーションを試みたがエラー・矛盾がある',
      'SPEC.mdが存在しない、またはPart2にマイグレーション情報が無く着手不能'
    )}`,
    { label: 'db-impl', phase: 'Contract + DB', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
])

countLoggable('contract-writer')
countLoggable('implementer')
log('Contract + DB完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// deny-by-default: 全員がpass（またはfindings全件minorのfail）でない限り止める
// （fail/blockedはもちろんnull・未知の値も止める。issue #289）
if (shouldBlock([contractResult, dbResult])) {
  log('品質ゲート: Contract + DBでfail/blockedを検知したため中断（Implement以降へは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    blocked: true,
    blockedAt: 'Contract + DB',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Contract + DB', expectedLoopObservabilityRecords: loggableAgentCount },
  }
}
logMinorOnlyPassThrough('Contract + DB', [contractResult, dbResult])

// ─── Phase B: data / api / ui（並列）─────────────────────────────────
// 3グループは contract-writer の出力（src/types/）を契約として参照する
// api-impl は SPEC.md Part 2 記載の関数シグネチャに従って呼び出すだけ（data-impl の完了を待たない）
// db-impl の完了報告も渡す（スキーマ変更があった場合に追従できるよう）
phase('Implement')

const implGuide = guide(
  '担当範囲の実装を完了できた',
  '実装したが明らかに不完全、またはcontract-writer/db-implの結果と矛盾する',
  'SPEC.mdが見つからない、またはcontract-writer/db-implの完了報告が空で着手できなかった'
)

const [dataResult, apiResult, uiResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/lib/supabase/ のデータアクセス関数を実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/lib/supabase/ と src/lib/*/repository.ts。\n\n## contract-writer完了報告\n${contractResult?.detail}\n\n## db-impl完了報告\n${dbResult?.detail}${implGuide}`,
    { label: 'data-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/**/route.ts（/api配下に限らない）を実装してください。\n型定義（src/types/）は確定済みです。\nPart 2 に記載の関数シグネチャに従って src/lib/ の関数を呼ぶこと（実装がまだでも名前・型が確定していれば前進可）。\n触ってよいファイル: src/app/**/route.ts のみ。\n\n## contract-writer完了報告\n${contractResult?.detail}\n\n## db-impl完了報告\n${dbResult?.detail}${implGuide}`,
    { label: 'api-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/(pages)/ と src/components/ のUIを実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/app/(pages)/ と src/components/ のみ。\n\n## contract-writer完了報告\n${contractResult?.detail}${implGuide}`,
    { label: 'ui-impl', phase: 'Implement', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  ),
])

countLoggable('implementer')
countLoggable('implementer')
countLoggable('implementer')
log('Implement完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック（deny-by-default）
if (shouldBlock([dataResult, apiResult, uiResult])) {
  log('品質ゲート: Implementでfail/blockedを検知したため中断（統合ゲートへは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    blocked: true,
    blockedAt: 'Implement',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Implement', expectedLoopObservabilityRecords: loggableAgentCount },
  }
}
logMinorOnlyPassThrough('Implement', [dataResult, apiResult, uiResult])

// ─── Phase C: 統合ゲート ──────────────────────────────────────────────
phase('Integrate')

const integrationResult = await agent(
  `並列実装が完了しました。以下の順で作業してください。\n0. まずReadツールで ${specPath} が存在するか確認する。存在しない場合、または下記の完了報告のいずれかに「仕様書が見つからない」「作業を開始できない」等の記述がある場合は、それを最優先の異常事態として報告の先頭に明記すること（該当implエージェントは未着手として扱い、テスト・lintが緑でも全体を正常完了と報告しないこと）。\n1. マイグレーションが適用済みか確認する（未適用ならSupabase CLIで適用する）\n2. 各implementerの成果を結線し、共有ファイルを編集する\n3. npm test を実行 → 失敗があれば修正（3回まで）\n4. npm run lint を実行 → 失敗があれば修正\n5. npx tsc --noEmit を実行 → 型エラーがあれば修正（3回まで。issue #46のDONE基準に型検査を含める）\n6. 全テスト・lint・tsc緑を確認して報告\n7. .aidd/run-manifest.json をReadツールで読み、manifest.baseCommitを取得する（無ければこのステップはスキップしてよい）。取得できた場合、Bashツールで \`git diff --name-only \${baseCommit}\`（baseCommitはmanifestの値に置き換える）を実行し、変更されたファイル一覧を取得する。取得できたら .aidd/run-manifest.json の changedFiles フィールドをその一覧で上書きし、Writeツールで保存する（docs/agents/run-manifest.md 参照。他フィールドは変更しないこと）。\n\n## 各完了報告\n### contract-writer\n${contractResult?.detail}\n### db-impl\n${dbResult?.detail}\n### data-impl\n${dataResult?.detail}\n### api-impl\n${apiResult?.detail}\n### ui-impl\n${uiResult?.detail}${guide(
    'npm test・npm run lint・npx tsc --noEmitが最終的に全て緑で統合完了',
    '3回の修正試行後もtest/lint/tscのいずれかが赤のまま',
    'SPEC.mdが見つからない、またはいずれかのimplエージェントの完了報告に「仕様書が見つからない」「作業を開始できない」旨の記述がある'
  )}`,
  { label: 'integrator', phase: 'Integrate', agentType: 'integrator', schema: AGENT_RESULT_SCHEMA }
)

countLoggable('integrator')
log('統合完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック（deny-by-default）
if (shouldBlock([integrationResult])) {
  log('品質ゲート: Integrateでfail/blockedを検知したため中断（Reviewへは進みません）')
  return {
    done: false,
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    integration: integrationResult,
    blocked: true,
    blockedAt: 'Integrate',
    stats: { phase: 'phase2', done: false, blocked: true, blockedAt: 'Integrate', expectedLoopObservabilityRecords: loggableAgentCount },
  }
}
logMinorOnlyPassThrough('Integrate', [integrationResult])

// ─── Phase D: 4観点並列レビュー（fail時はImplementerへ差し戻す修正ループ、最大3回）──
// issue #45/#292: 従来はReviewのstatus(fail)を一切見ずdetailのみ使い、指摘があっても
// 後続に何も反映されず「検証完了」として終わっていた。fail検出時はImplementerへ
// 差し戻して再修正させ、再度4観点レビューし直す。最大3回再試行し、それでもfailが
// 残る場合はblockedとして人間（停止②の構造化レビュー）に引き渡す。
// 判定ロジック: .claude/workflows/lib/review-retry.js の classifyReviewRound と同一
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// 重大度分類: findings全件がminorの指摘だけでは差し戻さない（UIの軽微な指摘で修正ループを
// 回さない。DB/ロジックのcritical/important指摘は従来通り差し戻し対象）
phase('Review')

const REVIEW_DIMENSIONS = [
  { key: 'correctness', label: '正しさ（バグ・境界条件）' },
  { key: 'coverage',    label: '仕様カバレッジ（受け入れ条件 vs 実装・テスト）' },
  { key: 'redundancy',  label: '重複・過剰実装・抜け漏れ' },
  { key: 'type-safety', label: '型安全・データ層の整合' },
]

const reviewGuide = guide(
  'レビューを完了し指摘なし',
  'レビューを完了し1件以上の指摘がある',
  'レビュー対象のコード・SPEC.mdが見つからずレビュー自体ができなかった'
)

// issue #314: blockedの観点はImplementerへの差し戻しでは解決しない（レビュー対象自体が
// 見つからない等）ため、fail判定より先に見て即座に打ち切る。従来はblockedのみの回を
// done=true,blocked=falseとして素通りしており、最終returnにblockedAtが付かず追跡できなかった。
function classifyReviewRound(results, dimensions, attempt, maxRetries) {
  const blockedDimensions = dimensions
    .map((dim, i) => ({ dim, result: results[i] }))
    .filter(({ result }) => result?.status === 'blocked')
  if (blockedDimensions.length > 0) return { done: true, blocked: true, failingDimensions: [], blockedDimensions }

  const failingDimensions = dimensions
    .map((dim, i) => ({ dim, result: results[i] }))
    .filter(({ result }) => result?.status === 'fail' && !isMinorOnlyFailure(result))
  if (failingDimensions.length === 0) return { done: true, blocked: false, failingDimensions: [], blockedDimensions: [] }
  if (attempt > maxRetries) return { done: true, blocked: true, failingDimensions, blockedDimensions: [] }
  return { done: false, blocked: false, failingDimensions, blockedDimensions: [] }
}

const MAX_REVIEW_RETRIES = 3
let reviewResults
let reviewAttempt = 0
let reviewRetryAgentCount = 0

while (true) {
  reviewAttempt++
  log(`Reviewラウンド ${reviewAttempt}/${MAX_REVIEW_RETRIES + 1} 開始`)

  reviewResults = await parallel(
    REVIEW_DIMENSIONS.map(dim => () => agent(
      `まず ${specPath} を Read ツールで読んでください。\n観点「${dim.label}」の視点のみでレビューしてください。\n指摘のみを箇条書きで返す。修正はしない。問題なければ「指摘なし」と返す。${reviewGuide}`,
      { label: `review:${dim.key}:R${reviewAttempt}`, agentType: 'reviewer', phase: 'Review', schema: AGENT_RESULT_SCHEMA }
    ))
  )

  REVIEW_DIMENSIONS.forEach(() => countLoggable('reviewer'))

  const { done, blocked, failingDimensions, blockedDimensions } = classifyReviewRound(reviewResults, REVIEW_DIMENSIONS, reviewAttempt, MAX_REVIEW_RETRIES)

  if (done && !blocked) {
    log(`Review完了: ラウンド${reviewAttempt}で全観点pass（指摘なし）`)
    logMinorOnlyPassThrough('Review', reviewResults)
    break
  }

  if (blocked) {
    const reason = blockedDimensions.length > 0
      ? `${blockedDimensions.length}件の観点でレビュー自体が実行できなかった（blocked）ため`
      : `${MAX_REVIEW_RETRIES}回の差し戻し後もfailが残るため`
    log(`品質ゲート: Reviewで${reason}中断（blockedとして人間に引き渡します）`)
    return {
      done: false,
      contractResult,
      dbResult,
      dataResult,
      apiResult,
      uiResult,
      integration: integrationResult,
      reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
        dimension: dim.label,
        findings:  reviewResults[i]?.detail ?? '指摘なし',
      })),
      blocked: true,
      blockedAt: 'Review',
      stats: {
        phase: 'phase2',
        done: false,
        blocked: true,
        blockedAt: 'Review',
        reviewBlockedDimensions: blockedDimensions.length,
        reviewRetries: reviewRetryAgentCount,
        expectedLoopObservabilityRecords: loggableAgentCount,
      },
    }
  }

  log(`Review: ${failingDimensions.length}件の観点でfailを検知（試行${reviewAttempt}/${MAX_REVIEW_RETRIES + 1}）→ Implementerへ差し戻します`)

  const retryFindings = failingDimensions
    .map(({ dim, result }) => `## ${dim.label}\n${result.detail}`)
    .join('\n\n')

  await agent(
    `まず ${specPath} を Read ツールで読んでください。\n以下はコードレビューで検出された指摘です。該当箇所を修正してください（修正のみ、レビューはしない）。\n\n${retryFindings}${guide(
      '指摘箇所をすべて修正できた',
      '修正を試みたが解決できない指摘が残る',
      '指摘内容から修正対象・該当ファイルが特定できない'
    )}`,
    { label: `implementer-retry:R${reviewAttempt}`, phase: 'Review', agentType: 'implementer', schema: AGENT_RESULT_SCHEMA }
  )
  countLoggable('implementer')
  reviewRetryAgentCount++
}

const implResults = [contractResult, dbResult, dataResult, apiResult, uiResult]

// DONE判定: .claude/workflows/lib/phase2-done.js の computeDone と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// issue #46: 修正ループ（Review差し戻し等）を実装しても、最終的な完了条件(DONE)が
// 明示されていないと「いつ止まっていいか」が曖昧になる。DONE = 全実装がpass（またはfindings
// 全件minorのfail） AND 統合ゲート(test/lint/tsc)がpass AND 全観点Reviewがpass AND
// specHashが一致、のすべてを満たした場合のみtrueにする。
function allPass(results) {
  return results.length > 0 && results.every(r => r?.status === 'pass' || isMinorOnlyFailure(r))
}
const done =
  allPass(implResults) &&
  integrationResult?.status === 'pass' &&
  allPass(reviewResults) &&
  manifestCheck?.status === 'pass'

log(`検証完了（DONE=${done}）。/structured-review でレビュー結果を確認してください。`)

return {
  done,
  manifestCheck,
  contractResult,
  dbResult,
  dataResult,
  apiResult,
  uiResult,
  integration:  integrationResult,
  reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
    dimension: dim.label,
    findings:  reviewResults[i]?.detail ?? '指摘なし',
  })),
  stats: {
    phase: 'phase2',
    done,
    implAgents: 5,
    reviewAgents: REVIEW_DIMENSIONS.length,
    reviewRetries: reviewRetryAgentCount,
    totalAgents: 1 + 5 + 1 + REVIEW_DIMENSIONS.length + reviewRetryAgentCount,
    implSuccessCount: implResults.filter(r => r?.status === 'pass').length,
    implBlockedCount: implResults.filter(r => r?.status === 'blocked').length,
    expectedLoopObservabilityRecords: loggableAgentCount,
  },
}
