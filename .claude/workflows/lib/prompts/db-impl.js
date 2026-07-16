// db-impl（.claude/workflows/aidd-phase2.js）のプロンプト文字列の正本。
// Workflow DSLはrequire不可のため、aidd-phase2.js側には同一内容をインライン複製している
// （guide()も含めて複製。quality-gate.js/severity.js等の既存パターンと同じ制約）。
// 両者の同期は .claude/workflows/lib/__tests__/workflow-prompt-sync.test.js が検証する。
//
// **重要**: このファイルのテンプレートリテラル本文（バッククォート内）を変更したら、
// aidd-phase2.js内の対応するインライン複製も一字一句同じ内容に更新すること。
// sync testが乖離を検知するが、修正自体は手動で行う必要がある(issue #391)。
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

export function buildDbImplPrompt(specPath) {
  return `まず ${specPath} を Read ツールで読んでください。\nPart 2（実装計画）をもとに supabase/migrations/ のマイグレーションファイルを実装してください。src/types/ / src/lib/ / src/app/ は触らないこと。\nPart 2にDBスキーマ変更が不要と明記されている場合（例:「該当なし」「DB変更なし」）は、何も実装せずstatus: passでdetailにその旨（不要と判断した根拠）を書いて報告すること。これはblocked（着手不能）ではない。\nDBスキーマ変更が必要そうだが、対象テーブル名・カラム設計・facilityスコープ（RLS）等をPart2や既存の型契約（src/types/）から安全に確定できない場合も、推測でマイグレーションを実装しようとせずstatus: blockedで不足している情報を具体的に書いて報告すること。これはfail（実装エラー・矛盾）ではなくblocked（着手に必要な情報が足りない）として扱う。${guide(
      'マイグレーション実装が完了した、またはPart2にDBスキーマ変更が不要と明記されており対応不要と判断した',
      'マイグレーションの実装を試みたがSQLの構文誤り・既存スキーマとの矛盾等の実装エラーが生じた',
      'SPEC.mdが存在しない、Part2にDB変更の要否自体を判断できる記載が無い、またはDB変更は必要そうだが対象テーブル・カラム設計・facilityスコープを安全に確定できるだけの情報が無い'
    )}`
}
