// aidd-phase1.js（`.claude/workflows/aidd-phase1.js`）のSweepフェーズが各sweep-*エージェントに
// 送るプロンプトの正本。Workflow DSLはrequire不可のためaidd-phase1.js側にインライン複製している。
// aidd-1-1-deep-task.jsのSweepフェーズも同一のSTATUS_GUIDE本文を使う（additionalContext分岐が
// 追加される点のみ異なる）。
// 両者の同期は .claude/workflows/lib/__tests__/sweep-prompt-sync.test.js が検証する（issue #431:
// sweep recallのeval基盤で、実際のsweep-*プロンプトと同じ文言をfixture実行に使うため）。
//
// **重要**: このファイルのテンプレートリテラル本文を変更したら、aidd-phase1.js /
// aidd-1-1-deep-task.js内の対応するインライン複製も一字一句同じ内容に更新すること。
const STATUS_GUIDE = `

## 出力形式
status と detail を返すこと。
- status: "pass"=調査を最後まで実行できた(指摘の有無は問わない) / "blocked"=権限不足・対象コード不在等で調査自体が実行できなかった
- detail: 調査結果の本文(指摘が無ければ「指摘なし」と書く)`

// scope: 'full'（既定）=新機能追加前の既存コード構造の全体把握。sweep-*エージェント側の
//   「決定的な探索手順」で対象ディレクトリを漏れなく列挙・確認する。
//   'focused'=バグ修正等、taskDescriptionに関連する範囲のみに絞り込んで調査する（issue #675:
//   aidd-1-1-deep-taskで全体監査が走りtaskDescriptionと無関係な仕様書が生成されていた問題の修正）。
export function buildSweepPrompt(taskDescription, scope = 'full') {
  const scopeLine = scope === 'focused'
    ? '\n調査範囲: focused（このタスクに直接関連するファイル・機能のみに絞り込むこと。無関係な全件列挙は不要）'
    : '\n調査範囲: full（新機能追加に向けた既存コード構造の全体像を把握するため、対象ディレクトリ全体を漏れなく確認すること）'
  return `タスク: ${taskDescription}${scopeLine}${STATUS_GUIDE}`
}
