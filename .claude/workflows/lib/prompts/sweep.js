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

export function buildSweepPrompt(taskDescription) {
  return `タスク: ${taskDescription}${STATUS_GUIDE}`
}
