import { supabase } from '@/lib/supabase/server'
import type { LoanReturn, LoanReturnInput, LoanReturnItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): LoanReturnItem {
  return {
    id: row.id as string,
    loanReturnId: row.loan_return_id as string,
    jan: row.jan as string,
    lot: row.lot != null ? (row.lot as string) : undefined,
    ubd: row.ubd != null ? (row.ubd as string) : undefined,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createLoanReturn(facilityId: string, input: LoanReturnInput): Promise<LoanReturn> {
  const { data: ret, error: retError } = await supabase
    .from('loan_returns')
    .insert({ facility_id: facilityId, return_datetime: input.returnDatetime })
    .select()
    .single()
  if (retError) throw new Error(retError.message)

  const r = ret as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    loan_return_id: r.id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('loan_return_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: r.id as string,
    facilityId: r.facility_id as string,
    returnDatetime: r.return_datetime as string,
    status: r.status as 'draft' | 'returned',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}
