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
// specPath: 承認済みSPEC.mdのパス（例: "docs/specs/SPEC.md"）
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

const specPath = args?.specPath ?? 'docs/specs/SPEC.md'

// ─── Phase A: Contract Write + DB（並列）─────────────────────────────
// contract-writer: src/types/ の型定義を確定（implementerの「契約」）
// db-impl: supabase/migrations/ を実装（SPEC.mdから直接、contract-writerと並行）
phase('Contract + DB')

const [contractResult, dbResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに src/types/ の型定義・APIインターフェース型を確定させてください。`,
    { label: 'contract-writer', phase: 'Contract + DB', agentType: 'contract-writer' }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。`,
    { label: 'db-impl', phase: 'Contract + DB', agentType: 'implementer' }
  ),
])

log('Contract + DB完了')

// ─── Phase B: data / api / ui（並列）─────────────────────────────────
// 3グループは contract-writer の出力（src/types/）を契約として参照する
// api-impl は SPEC.md Part 2 記載の関数シグネチャに従って呼び出すだけ（data-impl の完了を待たない）
// db-impl の完了報告も渡す（スキーマ変更があった場合に追従できるよう）
phase('Implement')

const [dataResult, apiResult, uiResult] = await parallel([
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/lib/supabase/ のデータアクセス関数を実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/lib/supabase/ のみ。\n\n## contract-writer完了報告\n${contractResult}\n\n## db-impl完了報告\n${dbResult}`,
    { label: 'data-impl', phase: 'Implement', agentType: 'implementer' }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/**/route.ts（/api配下に限らない）を実装してください。\n型定義（src/types/）は確定済みです。\nPart 2 に記載の関数シグネチャに従って src/lib/ の関数を呼ぶこと（実装がまだでも名前・型が確定していれば前進可）。\n触ってよいファイル: src/app/**/route.ts のみ。\n\n## contract-writer完了報告\n${contractResult}\n\n## db-impl完了報告\n${dbResult}`,
    { label: 'api-impl', phase: 'Implement', agentType: 'implementer' }
  ),
  () => agent(
    `まず ${specPath} を Read ツールで読んでください。\nPart 2をもとに src/app/(pages)/ と src/components/ のUIを実装してください。\n型定義（src/types/）は確定済みです。\n触ってよいファイル: src/app/(pages)/ と src/components/ のみ。\n\n## contract-writer完了報告\n${contractResult}`,
    { label: 'ui-impl', phase: 'Implement', agentType: 'implementer' }
  ),
])

log('Implement完了')

// ─── Phase C: 統合ゲート ──────────────────────────────────────────────
phase('Integrate')

const integrationResult = await agent(
  `並列実装が完了しました。以下の順で作業してください。\n1. マイグレーションが適用済みか確認する（未適用ならSupabase CLIで適用する）\n2. 各implementerの成果を結線し、共有ファイルを編集する\n3. npm test を実行 → 失敗があれば修正（3回まで）\n4. npm run lint を実行 → 失敗があれば修正\n5. 全テスト・lint緑を確認して報告\n\n## 各完了報告\n### contract-writer\n${contractResult}\n### db-impl\n${dbResult}\n### data-impl\n${dataResult}\n### api-impl\n${apiResult}\n### ui-impl\n${uiResult}`,
  { label: 'integrator', phase: 'Integrate', agentType: 'integrator' }
)

log('統合完了')

// ─── Phase D: 4観点並列レビュー ───────────────────────────────────────
phase('Review')

const REVIEW_DIMENSIONS = [
  { key: 'correctness', label: '正しさ（バグ・境界条件）' },
  { key: 'coverage',    label: '仕様カバレッジ（受け入れ条件 vs 実装・テスト）' },
  { key: 'redundancy',  label: '重複・過剰実装・抜け漏れ' },
  { key: 'type-safety', label: '型安全・データ層の整合' },
]

const reviewResults = await parallel(
  REVIEW_DIMENSIONS.map(dim => () => agent(
    `まず ${specPath} を Read ツールで読んでください。\n観点「${dim.label}」の視点のみでレビューしてください。\n指摘のみを箇条書きで返す。修正はしない。問題なければ「指摘なし」と返す。`,
    { label: `review:${dim.key}`, agentType: 'reviewer', phase: 'Review' }
  ))
)

log('検証完了。/structured-review でレビュー結果を確認してください。')

return {
  contractResult,
  dbResult,
  dataResult,
  apiResult,
  uiResult,
  integration:  integrationResult,
  reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
    dimension: dim.label,
    findings:  reviewResults[i] ?? '指摘なし',
  })),
  stats: {
    phase: 'phase2',
    implAgents: 5,
    reviewAgents: REVIEW_DIMENSIONS.length,
    totalAgents: 5 + 1 + REVIEW_DIMENSIONS.length,
    implSuccessCount: [contractResult, dbResult, dataResult, apiResult, uiResult].filter(Boolean).length,
  },
}
