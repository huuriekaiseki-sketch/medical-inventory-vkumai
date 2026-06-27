import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber } from '@/lib/mapping'
import type { LoanOrder, LoanOrderInput, LoanOrderItem } from '@/types/order'

interface LoanOrderItemRow {
  id?: unknown
  loan_order_id?: unknown
  jan?: unknown
  name?: unknown
  quantity?: unknown
  created_at?: unknown
}

interface LoanOrderRow {
  id?: unknown
  facility_id?: unknown
  procedure_name?: unknown
  maker?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapItem(row: LoanOrderItemRow): LoanOrderItem {
  return {
    id: asString(row.id),
    loanOrderId: asString(row.loan_order_id),
    jan: asOptionalString(row.jan),
    name: asString(row.name),
    quantity: asNumber(row.quantity),
    createdAt: asString(row.created_at),
  }
}

export async function createLoanOrder(db: SupabaseClient, facilityId: string, input: LoanOrderInput): Promise<LoanOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await db.rpc('create_loan_order_atomic', {
    p_facility_id: facilityId,
    p_procedure_name: input.procedureName,
    p_maker: input.maker,
    p_items: JSON.stringify(
      input.items.map(item => ({
        jan: item.jan ?? null,
        name: item.name,
        quantity: item.quantity,
      }))
    ),
  })
  if (error) throw new Error(error.message)

  const o = (data ?? {}) as LoanOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as LoanOrderItemRow[]) : []

  return {
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    procedureName: asString(o.procedure_name),
    maker: asString(o.maker),
    status: asString(o.status) as 'draft' | 'submitted',
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
