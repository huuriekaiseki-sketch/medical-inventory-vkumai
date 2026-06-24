import { supabase } from '@/lib/supabase/server'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): ConsumableOrderItem {
  return {
    id: row.id as string,
    consumableOrderId: row.consumable_order_id as string,
    consumableId: row.consumable_id as string,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createConsumableOrder(facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder> {
  const { data: order, error: orderError } = await supabase
    .from('consumable_orders')
    .insert({ facility_id: facilityId })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const o = order as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    consumable_order_id: o.id,
    consumable_id: item.consumableId,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('consumable_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
