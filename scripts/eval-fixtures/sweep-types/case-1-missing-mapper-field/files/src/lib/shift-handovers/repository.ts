import type { ShiftHandoverItem } from '@/types/shift-handovers'

type ShiftHandoverRow = {
  id: string
  name: string
  internal_note: string | null
}

export function mapRow(row: ShiftHandoverRow): ShiftHandoverItem {
  // @ts-expect-error 呼び出し元が依存しているフィールドを含めて返す
  return {
    id: row.id,
    name: row.name,
    internalNote: row.internal_note,
  }
}
