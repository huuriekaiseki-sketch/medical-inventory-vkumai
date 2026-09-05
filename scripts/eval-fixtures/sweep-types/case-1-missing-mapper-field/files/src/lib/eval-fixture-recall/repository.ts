import type { EvalFixtureRecallItem } from '@/types/eval-fixture-recall'

type EvalFixtureRecallRow = {
  id: string
  name: string
  internal_note: string | null
}

export function mapRow(row: EvalFixtureRecallRow): EvalFixtureRecallItem {
  // @ts-expect-error 呼び出し元が依存しているフィールドを含めて返す
  return {
    id: row.id,
    name: row.name,
    internalNote: row.internal_note,
  }
}
