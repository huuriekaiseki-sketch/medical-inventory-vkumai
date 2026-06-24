import { supabase } from '@/lib/supabase/server'
import type { LoanOrder, LoanOrderInput, LoanOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): LoanOrderItem {
  return {
    id: row.id as string,
    loanOrderId: row.loan_order_id as string,
    jan: row.jan != null ? (row.jan as string) : undefined,
    name: row.name as string,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createLoanOrder(facilityId: string, input: LoanOrderInput): Promise<LoanOrder> {
  const { data: order, error: orderError } = await supabase
    .from('loan_orders')
    .insert({ facility_id: facilityId, procedure_name: input.procedureName, maker: input.maker })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const o = order as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    loan_order_id: o.id,
    jan: item.jan ?? null,
    name: item.name,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('loan_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    procedureName: o.procedure_name as string,
    maker: o.maker as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
