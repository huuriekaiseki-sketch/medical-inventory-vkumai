import type { WardSupplyItem } from '@/types/ward-supplies'

type WardSupplyRow = {
  id: string
  name: string
  internal_note: string | null
}

// DB の列と型定義の項目が 1 対 1 で対応している（欠けも余りも無い）
export function mapRow(row: WardSupplyRow): WardSupplyItem {
  return {
    id: row.id,
    name: row.name,
    internalNote: row.internal_note,
  }
}
