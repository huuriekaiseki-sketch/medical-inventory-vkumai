import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import type { LoanReturn, LoanReturnInput, LoanReturnItem } from '@/types/order'

const STATUSES = ['draft', 'returned'] as const

const LOAN_RETURN_COLUMNS = 'id, facility_id, return_datetime, status, created_at, updated_at'
// 注: updated_at は Group A のマイグレーション適用前のため明細列挙には含めない
const LOAN_RETURN_ITEM_COLUMNS = 'id, loan_return_id, jan, lot, ubd, quantity, created_at'

interface LoanReturnItemRow {
  id?: unknown
  loan_return_id?: unknown
  jan?: unknown
  lot?: unknown
  ubd?: unknown
  quantity?: unknown
  created_at?: unknown
}

interface LoanReturnRow {
  id?: unknown
  facility_id?: unknown
  return_datetime?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapItem(row: LoanReturnItemRow): LoanReturnItem {
  return {
    id: asString(row.id),
    loanReturnId: asString(row.loan_return_id),
    jan: asString(row.jan),
    lot: asOptionalString(row.lot),
    ubd: asOptionalString(row.ubd),
    quantity: asNumber(row.quantity),
    createdAt: asString(row.created_at),
  }
}

export async function listLoanReturns(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0
): Promise<LoanReturn[]> {
  const { data, error } = await db
    .from('loan_returns')
    .select(`${LOAN_RETURN_COLUMNS}, loan_return_items(${LOAN_RETURN_ITEM_COLUMNS})`)
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (LoanReturnRow & { loan_return_items?: LoanReturnItemRow[] })[]).map(r => ({
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: (r.loan_return_items ?? []).map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
  }))
}

export async function createLoanReturn(db: SupabaseClient, facilityId: string, input: LoanReturnInput): Promise<LoanReturn> {
  const { data: ret, error: retError } = await db
    .from('loan_returns')
    .insert({ facility_id: facilityId, return_datetime: input.returnDatetime })
    .select(LOAN_RETURN_COLUMNS)
    .single()
  if (retError) throw new Error(retError.message)
  if (!ret) throw new Error('loan_returns の作成に失敗しました')

  const r = ret as LoanReturnRow
  const itemRows = input.items.map(item => ({
    loan_return_id: r.id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await db
    .from('loan_return_items')
    .insert(itemRows)
    .select(LOAN_RETURN_ITEM_COLUMNS)
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: asString(r.id),
    facilityId: asString(r.facility_id),
    returnDatetime: asString(r.return_datetime),
    status: asEnum(r.status, STATUSES, 'draft'),
    items: (items as LoanReturnItemRow[]).map(mapItem),
    createdAt: asString(r.created_at),
    updatedAt: asString(r.updated_at),
  }
}
