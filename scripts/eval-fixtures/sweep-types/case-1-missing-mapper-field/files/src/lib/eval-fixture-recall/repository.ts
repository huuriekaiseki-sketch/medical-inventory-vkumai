// issue #431のrecallベンチマーク用fixture。src/types/eval-fixture-recall.tsの
// EvalFixtureRecallItem型は`internalNote`を宣言していないが、このmapRow()は
// DB列`internal_note`を含めてマッピングしている（型定義とmapperの層間不一致）。
import type { EvalFixtureRecallItem } from '@/types/eval-fixture-recall'

type EvalFixtureRecallRow = {
  id: string
  name: string
  internal_note: string | null
}

export function mapRow(row: EvalFixtureRecallRow): EvalFixtureRecallItem & { internalNote: string | null } {
  return {
    id: row.id,
    name: row.name,
    internalNote: row.internal_note,
  }
}
