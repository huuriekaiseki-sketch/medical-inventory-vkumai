// Workflowツール実行系のargsがverbatimでなく文字列化されて渡ってくる既知の不具合への
// 回避策（`.claude/workflows/aidd-phase1-router.js`）を、Node側の純粋関数として切り出した
// もの（issue #413のload-bearing workaround棚卸し対象）。
//
// 背景: Workflowツールに`args: {"taskDescription": "..."}`をオブジェクトとして渡しても、
// スクリプト内で受け取ったargsが`typeof args === 'string'`になる（JSON文字列化された状態で
// 渡ってくる）ことを診断用スクリプトで確認した（docs/agents/decisions.md「なぜ
// aidd-phase1-router.jsでargsをJSON.parseする防御コードを入れたか」参照）。
//
// 注意（構造的な制約）: Workflow DSL（aidd-phase1-router.js）自体はrequire不可のため、
// この関数の判定ロジックはaidd-phase1-router.js内にインライン複製されている
// （1行のみのため、他の複製箇所のようなsync testは設けていない。ロジックを変更する場合は
// 両方を手動で追従させること）。
export function resolveWorkflowArgs(args) {
  return typeof args === 'string' ? JSON.parse(args) : args
}
