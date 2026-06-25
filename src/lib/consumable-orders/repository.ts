import { supabase } from '@/lib/supabase/server'
import { asString, asNumber } from '@/lib/mapping'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem } from '@/types/order'

interface ConsumableOrderItemRow {
  id?: unknown
  consumable_order_id?: unknown
  consumable_id?: unknown
  quantity?: unknown
  created_at?: unknown
}

interface ConsumableOrderRow {
  id?: unknown
  facility_id?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapItem(row: ConsumableOrderItemRow): ConsumableOrderItem {
  return {
    id: asString(row.id),
    consumableOrderId: asString(row.consumable_order_id),
    consumableId: asString(row.consumable_id),
    quantity: asNumber(row.quantity),
    createdAt: asString(row.created_at),
  }
}

export async function createConsumableOrder(facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await supabase.rpc('create_consumable_order_atomic', {
    p_facility_id: facilityId,
    p_items: JSON.stringify(
      input.items.map(item => ({
        consumable_id: item.consumableId,
        quantity: item.quantity,
      }))
    ),
  })
  if (error) throw new Error(error.message)

  const o = (data ?? {}) as ConsumableOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as ConsumableOrderItemRow[]) : []

  return {
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    status: asString(o.status) as 'draft' | 'submitted',
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
