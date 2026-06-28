export const meta = {
  name: 'aidd-phase2',
  description: 'Phase 3-5: TDD並列実装 → 統合ゲート → 4観点並列検証。仕様書承認後（停止①の後）に実行。',
  whenToUse: '人間が仕様書（SPEC.md）を承認した後、Phase 3 実装に入るときに使う。',
  phases: [
    { title: 'Phase 3: 実装',  detail: '並列グループごとにimplementerを同時起動（TDD）' },
    { title: 'Phase 4: 統合',  detail: 'integratorが共有ファイルを結線・test/lint確認' },
    { title: 'Phase 5: 検証',  detail: '4観点並列reviewer（読み取り専用）' },
  ],
}

// args: {
//   specContent: string,           // SPEC.md の全文
//   parallelGroups: Array<{        // 仕様書 Part 2 の並列グループ宣言
//     name: string,
//     description: string,
//   }>
// }
//
// ── 完了後の手順（Claude が実行すること）──────────────────────────────
// 1. 【停止②】ユーザーに /structured-review の実行を促して停止する
//    （structured-review は Claude から勝手に呼ばない）
// ────────────────────────────────────────────────────────────────────
const specContent     = args?.specContent     ?? '（仕様書を args.specContent で渡してください）'
const parallelGroups  = args?.parallelGroups  ?? [{ name: 'default', description: '仕様書に従って実装してください' }]

// ─── Phase 3: 並列実装 ───────────────────────────────────────────────
phase('Phase 3: 実装')
log(`${parallelGroups.length}グループを並列実装開始`)

const implResults = await parallel(
  parallelGroups.map(group => () => agent(
    `以下の仕様書に従って「${group.name}」グループを TDD で実装してください。\n\n## 担当グループの範囲\n${group.description}\n\n## 仕様書（全文）\n${specContent}\n\n【重要】自分のファイルと自分のテストだけを書く。共有ファイル（index・ルーティング・グローバル設定等）は触らない。`,
    { label: `impl:${group.name}`, agentType: 'implementer', phase: 'Phase 3: 実装' }
  ))
)

const successCount = implResults.filter(Boolean).length
log(`実装完了: ${successCount}/${parallelGroups.length}グループ`)

// ─── Phase 4: 統合ゲート ─────────────────────────────────────────────
phase('Phase 4: 統合')

const implSummary = implResults
  .map((r, i) => `### グループ: ${parallelGroups[i]?.name ?? i}\n${r ?? '（失敗）'}`)
  .join('\n\n')

const integrationResult = await agent(
  `以下の並列実装結果を統合してください。共有ファイルの結線（ルーティング・index exports等）を行い、npm test と npm run lint を実行して緑を確認してください。\n\n## 仕様書\n${specContent}\n\n## 各グループの実装結果\n${implSummary}`,
  { label: 'integrator', agentType: 'integrator', phase: 'Phase 4: 統合' }
)

log(`統合完了`)

// ─── Phase 5: 4観点並列検証 ───────────────────────────────────────────
phase('Phase 5: 検証')

const REVIEW_DIMENSIONS = [
  { key: 'correctness', label: '正しさ（バグ・境界条件）' },
  { key: 'coverage',    label: '仕様カバレッジ（受け入れ条件 vs 実装・テスト）' },
  { key: 'redundancy',  label: '重複・過剰実装・抜け漏れ' },
  { key: 'type-safety', label: '型安全・データ層の整合' },
]

const reviewResults = await parallel(
  REVIEW_DIMENSIONS.map(dim => () => agent(
    `観点「${dim.label}」の視点のみでレビューしてください。\n\n## 仕様書\n${specContent}\n\n指摘のみを箇条書きで返す。修正はしない。問題なければ「指摘なし」と返す。`,
    { label: `review:${dim.key}`, agentType: 'reviewer', phase: 'Phase 5: 検証' }
  ))
)

log(`検証完了。/structured-review でレビュー結果を確認してください。`)

return {
  implGroups:   successCount,
  integration:  integrationResult,
  reviewFindings: REVIEW_DIMENSIONS.map((dim, i) => ({
    dimension: dim.label,
    findings:  reviewResults[i] ?? '指摘なし',
  })),
}
