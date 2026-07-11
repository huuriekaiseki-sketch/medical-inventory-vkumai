export const meta = {
  name: 'aidd-phase2',
  description: 'Phase 3-5: contract-first並列実装 → 統合ゲート → 4観点並列検証。仕様書承認後（停止①の後）に実行。',
  whenToUse: '人間が仕様書（SPEC.md）を承認した後、Phase 3 実装に入るときに使う。aidd-1-1-deep-task.jsの後続として使う。',
  phases: [
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

// docs/agents/agent-result-schema.md 参照。実装/統合/レビュー系はpass/fail/blockedの3値
const AGENT_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail', 'blocked'] },
    detail: { type: 'string' },
  },
  required: ['status', 'detail'],
}

const guide = (pass, fail, blocked) => `

## 出力形式
status と detail を返すこと。
- pass: ${pass}
- fail: ${fail}
- blocked: ${blocked}`

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

log('Contract + DB完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック
// （Workflow DSLはrequire不可のためインライン複製。ロジックの正本・テストはlib側）
// blockedもfail同様に後続へ進めない（着手不能な前提のまま実装を続けさせない）
if ([contractResult, dbResult].some(r => r?.status === 'fail' || r?.status === 'blocked')) {
  log('品質ゲート: Contract + DBでfail/blockedを検知したため中断（Implement以降へは進みません）')
  return {
    contractResult,
    dbResult,
    blocked: true,
    blockedAt: 'Contract + DB',
    stats: { phase: 'phase2', blocked: true, blockedAt: 'Contract + DB' },
  }
}

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

log('Implement完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック
if ([dataResult, apiResult, uiResult].some(r => r?.status === 'fail' || r?.status === 'blocked')) {
  log('品質ゲート: Implementでfail/blockedを検知したため中断（統合ゲートへは進みません）')
  return {
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    blocked: true,
    blockedAt: 'Implement',
    stats: { phase: 'phase2', blocked: true, blockedAt: 'Implement' },
  }
}

// ─── Phase C: 統合ゲート ──────────────────────────────────────────────
phase('Integrate')

const integrationResult = await agent(
  `並列実装が完了しました。以下の順で作業してください。\n0. まずReadツールで ${specPath} が存在するか確認する。存在しない場合、または下記の完了報告のいずれかに「仕様書が見つからない」「作業を開始できない」等の記述がある場合は、それを最優先の異常事態として報告の先頭に明記すること（該当implエージェントは未着手として扱い、テスト・lintが緑でも全体を正常完了と報告しないこと）。\n1. マイグレーションが適用済みか確認する（未適用ならSupabase CLIで適用する）\n2. 各implementerの成果を結線し、共有ファイルを編集する\n3. npm test を実行 → 失敗があれば修正（3回まで）\n4. npm run lint を実行 → 失敗があれば修正\n5. 全テスト・lint緑を確認して報告\n\n## 各完了報告\n### contract-writer\n${contractResult?.detail}\n### db-impl\n${dbResult?.detail}\n### data-impl\n${dataResult?.detail}\n### api-impl\n${apiResult?.detail}\n### ui-impl\n${uiResult?.detail}${guide(
    'npm test・npm run lintが最終的に緑で統合完了',
    '3回の修正試行後もtest/lintが赤のまま',
    'SPEC.mdが見つからない、またはいずれかのimplエージェントの完了報告に「仕様書が見つからない」「作業を開始できない」旨の記述がある'
  )}`,
  { label: 'integrator', phase: 'Integrate', agentType: 'integrator', schema: AGENT_RESULT_SCHEMA }
)

log('統合完了')

// 品質ゲート: .claude/workflows/lib/quality-gate.js の shouldBlock と同一ロジック
if ([integrationResult].some(r => r?.status === 'fail' || r?.status === 'blocked')) {
  log('品質ゲート: Integrateでfail/blockedを検知したため中断（Reviewへは進みません）')
  return {
    contractResult,
    dbResult,
    dataResult,
    apiResult,
    uiResult,
    integration: integrationResult,
    blocked: true,
    blockedAt: 'Integrate',
    stats: { phase: 'phase2', blocked: true, blockedAt: 'Integrate' },
  }
}

// ─── Phase D: 4観点並列レビュー ───────────────────────────────────────
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

const reviewResults = await parallel(
  REVIEW_DIMENSIONS.map(dim => () => agent(
    `まず ${specPath} を Read ツールで読んでください。\n観点「${dim.label}」の視点のみでレビューしてください。\n指摘のみを箇条書きで返す。修正はしない。問題なければ「指摘なし」と返す。${reviewGuide}`,
    { label: `review:${dim.key}`, agentType: 'reviewer', phase: 'Review', schema: AGENT_RESULT_SCHEMA }
  ))
)

log('検証完了。/structured-review でレビュー結果を確認してください。')

const implResults = [contractResult, dbResult, dataResult, apiResult, uiResult]

return {
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
    implAgents: 5,
    reviewAgents: REVIEW_DIMENSIONS.length,
    totalAgents: 5 + 1 + REVIEW_DIMENSIONS.length,
    implSuccessCount: implResults.filter(r => r?.status === 'pass').length,
    implBlockedCount: implResults.filter(r => r?.status === 'blocked').length,
  },
}
