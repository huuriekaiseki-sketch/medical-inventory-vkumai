// Manifest Check（.claude/workflows/aidd-phase2.js）のプロンプト文字列の正本。
// Workflow DSLはrequire不可のため、aidd-phase2.js側には同一内容をインライン複製している
// （guide()も含めて複製。spec-check.js・db-impl.js等の既存パターンと同じ制約）。
// 両者の同期は .claude/workflows/lib/__tests__/manifest-check-prompt-sync.test.js が検証する。
//
// WHY(2026-09-11 に正本を作った): Spec Check には 2026-07 から同期テストがあったのに、
// **Manifest Check には無かった**。lib/manifest-check.js は判定表を純粋関数として持つだけで
// プロンプト文言は持たず、同ファイル自身が「プロンプト文言を変更した場合、このファイルと
// テストも手動で追従させる必要がある（自動では同期されない）」と書いていた——
// つまり**穴があることは分かっていて、隣（Spec Check）に開けた門を広げていなかった**
// （docs/agents/check-design-pitfalls.md の C-047）。
// Manifest Check は deny-by-default のゲートで、ここが黙って緩むと
// 「承認記録が無い」「specHash 不一致」を通してしまう。
//
// **重要**: このファイルのテンプレートリテラル本文（バッククォート内）を変更したら、
// aidd-phase2.js内の対応するインライン複製も一字一句同じ内容に更新すること。
// sync testが乖離を検知するが、修正自体は手動で行う必要がある（spec-check.js と同じ制約）。
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

export function buildManifestCheckPrompt(specPath) {
  return `.aidd/run-manifest.json を Read ツールで読んでください（docs/agents/run-manifest.md にスキーマの説明があります）。\n\n以下を順に確認してください。\n1. .aidd/run-manifest.json が存在しない → blocked。detailに「Run Manifestが存在しません」と書く。\n2. manifest.approval（approvedBy/approvedAt）が無い → blocked。detailに「停止①の承認が記録されていません」と書く。\n3. manifest.specHash が無い → blocked。detailに「specHashが記録されていません」と書く。\n4. 上記が揃っていれば、${specPath} の現在の内容からsha256ハッシュを計算し（Bashツールで shasum -a 256 ${specPath} 等を使ってよい）、manifest.specHash と比較する。\n   - 一致すれば pass。detailに「specHash一致（承認後にSPEC.mdの変更なし）」と書く。\n   - 不一致であれば blocked。detailに「specHash不一致: レビュー承認後にSPEC.mdが変更された可能性があります（manifestの値と実際の値の両方を明記）」と書く。${guide(
    'specHashが一致し、承認記録も揃っている',
    '（未使用: このエージェントはpass/blockedの2値のみ返す）',
    'manifestが存在しない、承認記録が無い、またはspecHashが不一致'
  )}`
}
