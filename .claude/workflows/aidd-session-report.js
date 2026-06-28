export const meta = {
  name: 'aidd-session-report',
  description: 'AIDDセッション終了後にサマリーを docs/sessions/ へ書き出す',
  whenToUse: 'AIDDフロー（Phase 1〜5）が完了したセッションの終わりに呼ぶ。',
  phases: [
    { title: 'Report', detail: 'サマリー生成・ファイル書き出し' },
  ],
}

// args: {
//   feature: string,          // 機能名（例: "login-multitenant"）
//   date: string,             // 実行日 YYYY-MM-DD（例: "2026-06-28"）
//   phase1Stats?: object,     // aidd-phase1.js の戻り値.stats
//   phase2Stats?: object,     // aidd-phase2.js の戻り値.stats
//   notes?: string,           // 人間が追記したいメモ（任意）
// }

const feature     = args?.feature  ?? 'unknown-feature'
const date        = args?.date     ?? '????-??-??'
const phase1Stats = args?.phase1Stats ?? null
const phase2Stats = args?.phase2Stats ?? null
const notes       = args?.notes    ?? ''

phase('Report')

const reportPath = `docs/sessions/${date}-${feature}.md`

const report = await agent(
  `以下の情報をもとに、AIDDセッションレポートを Markdown で生成してください。
生成したレポートを \`${reportPath}\` に書き出してください（ディレクトリがなければ作成してください）。

## セッション情報
- 機能名: ${feature}
- 実行日: ${date}

## Phase 1 stats
${phase1Stats ? JSON.stringify(phase1Stats, null, 2) : '（データなし）'}

## Phase 2 stats
${phase2Stats ? JSON.stringify(phase2Stats, null, 2) : '（データなし）'}

## 追記メモ
${notes || '（なし）'}

## レポートフォーマット（このとおりに生成する）
\`\`\`markdown
# ${date} ${feature}

## フロー実行統計

### Phase 1 調査
- Sweeper: ${phase1Stats?.agents ?? '?'}台 × ${phase1Stats?.rounds ?? '?'}ラウンド
- 指摘あり軸数: ${phase1Stats?.findingCount ?? '?'} / 4

### Phase 2〜5 実装・検証
- implementer: ${phase2Stats?.implAgents ?? '?'}台（並列）
- integrator: 1台
- reviewer: ${phase2Stats?.reviewAgents ?? '?'}台（並列）
- 合計エージェント数: ${phase2Stats?.totalAgents ?? '?'}台
- 実装成功グループ数: ${phase2Stats?.implSuccessCount ?? '?'} / ${phase2Stats?.implAgents ?? '?'}

## 結果サマリー
- うまくいったこと: （生成時に記入）
- 問題・気になった点: （生成時に記入）
- 次の課題: （生成時に記入）

## メモ
${notes || '（なし）'}
\`\`\`

ファイルを書き出したら「レポートを ${reportPath} に書き出しました」とだけ返してください。`,
  { label: 'report-writer', agentType: 'implementer', phase: 'Report' }
)

log(`セッションレポート完了: ${reportPath}`)

return { reportPath, summary: report }
