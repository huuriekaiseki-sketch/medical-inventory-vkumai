// Spec Check（.claude/workflows/aidd-phase2.js）のプロンプト文字列の正本。
// Workflow DSLはrequire不可のため、aidd-phase2.js側には同一内容をインライン複製している
// （guide()も含めて複製。db-impl.js等の既存パターンと同じ制約）。
// 両者の同期は .claude/workflows/lib/__tests__/spec-check-prompt-sync.test.js が検証する。
//
// issue #507: 従来の除外指示「指定されたパス以外のファイル（例: リポジトリルート直下の
// 別のSPEC.md）」という文言が、specPathが実際に'SPEC.md'（デフォルト・推奨例）の場合に
// 対象ファイル自身と文字列衝突し、エージェントが「指定パスがプロンプトに見当たらない」→
// prompt injectionを疑い誤ってblockedを返す事例が実測された（issue #493のフロー実行、
// transcript agent-a6217db18cff1996dのthinkingで確認済み）。具体的なファイル名の例示を
// 排除し、${specPath}変数への相対表現のみで除外を指示する形に修正した。
//
// **重要**: このファイルのテンプレートリテラル本文（バッククォート内）を変更したら、
// aidd-phase2.js内の対応するインライン複製も一字一句同じ内容に更新すること。
// sync testが乖離を検知するが、修正自体は手動で行う必要がある(issue #391と同じ制約)。
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

export function buildSpecCheckPrompt(specPath) {
  return `Readツールで ${specPath} が存在し読み込めるか確認してください。今回読むべき対象は ${specPath} のみです。他の場所に同じファイル名の別ファイルが見つかったとしても、${specPath} 以外は絶対に読まないでください。それ以外は何もしないでください。\n\n完了報告のactualPathフィールドに、実際にReadツールへ渡した絶対パスを（今回指定された ${specPath} をそのまま解決したもので）必ず記載してください。${guide(
    `${specPath}が存在し読み込めた`,
    '（未使用: このエージェントはpass/blockedの2値のみ返す）',
    `${specPath}が存在しない、または読み込めない`
  )}`
}
