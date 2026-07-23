// aidd-phase2.js のReviewリトライループ（issue #490）向け、前回attemptの修正履歴を
// 次のimplementer-retryプロンプトへ引き継ぐための純粋関数。
//
// 背景: 従来はReviewリトライのたびに新規のimplementerエージェントを起動し、レビュー指摘の
// 文字列のみを渡していた。前回のretryで何をどう修正したかの情報が引き継がれないため、
// 各attemptがゼロから修正対象を再発見しており、同じ修正の繰り返しや矛盾する修正のリスクが
// あった（2026-07-21レビュー指摘4-1。Fable 5公式ガイドは「サブタスク間でコンテキストを
// 保持する長寿命のサブエージェント」を推奨しているが、Workflow DSLにエージェント継続APIが
// 無い制約下では、プロンプトへの履歴引き渡しで軽減する）。
//
// エージェント呼び出しを含まない純粋関数のため、LLM呼び出し無しで決定的にテストできる。
// aidd-phase2.js（Workflow DSL、require不可）にも同一ロジックをインラインで複製している。
// このファイルはvitestでの単体テスト用の正本。

const MAX_RETRY_HISTORY_ENTRIES = 2

// retryHistory: [{ attempt, findings, detail }, ...]（蓄積順。attemptは1始まりのReviewラウンド番号）
// プロンプト肥大対策として直近MAX_RETRY_HISTORY_ENTRIES件のみ含める。
// 履歴が空の場合は空文字列を返す（1回目のretryではプロンプトへセクション自体を追加しない）。
export function buildRetryHistorySection(retryHistory) {
  if (!Array.isArray(retryHistory) || retryHistory.length === 0) return ''
  const recent = retryHistory.slice(-MAX_RETRY_HISTORY_ENTRIES)
  const entries = recent
    .map(({ attempt, findings, detail }) => `### attempt ${attempt}\n指摘:\n${findings}\n\n修正報告:\n${detail ?? '(報告なし)'}`)
    .join('\n\n')
  return `\n\n## 前回までの修正履歴\n${entries}`
}
