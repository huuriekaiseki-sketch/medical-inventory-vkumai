// issue #431のrecallベンチマーク用fixture。src/types/eval-fixture-recall.tsの
// EvalFixtureRecallItem型は`internalNote`を宣言していないが、このmapRow()は
// 宣言済みの戻り値型を偽って`internalNote`を含むオブジェクトを返している
// （型定義とmapperの層間不一致。実際にはTypeScriptの余剰プロパティチェックに
// より型エラーになる箇所だが、意図的に@ts-expect-errorで抑制している）。
import type { EvalFixtureRecallItem } from '@/types/eval-fixture-recall'

type EvalFixtureRecallRow = {
  id: string
  name: string
  internal_note: string | null
}

export function mapRow(row: EvalFixtureRecallRow): EvalFixtureRecallItem {
  // @ts-expect-error internalNoteはEvalFixtureRecallItem型に宣言されていないが、
  // 呼び出し元は実際にこのフィールドに依存している（issue #431のrecallベンチマーク用fixture）
  return {
    id: row.id,
    name: row.name,
    internalNote: row.internal_note,
  }
}
