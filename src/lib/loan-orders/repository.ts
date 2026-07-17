import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { LoanOrder, LoanOrderInput, LoanOrderItem } from '@/types/order'

const STATUSES = ['draft', 'submitted'] as const

interface LoanOrderItemRow {
  id?: unknown
  loan_order_id?: unknown
  jan?: unknown
  name?: unknown
  quantity?: unknown
  unit_price?: unknown
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
    unitPrice: asNullableNumber(row.unit_price),
    createdAt: asString(row.created_at),
  }
}

// WHY: 重複定義していたフィルタ型を src/lib/orders/list-filter.ts に統合（issue #20 レビュー指摘）
export type LoanOrderListFilter = OrderRepositoryFilter

export async function listLoanOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  filter?: LoanOrderListFilter
): Promise<LoanOrder[]> {
  let query = db
    .from('loan_orders')
    .select('*, loan_order_items(*)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter?.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter?.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))

  // WHY: keyword は procedure_name / maker / items[].name の OR一致が要件。
  //      DB側のilikeだけではAND条件になり items のみ一致する行を取りこぼすため、
  //      keyword指定時はDB側でrangeせず取得してからJS側でOR一致判定し、
  //      その後にoffset/limitを適用する（filter未指定時は従来通りDB側でrangeする）。
  //      無制限取得はDoSベクタになるため created_at 降順 KEYWORD_SCAN_LIMIT 件で打ち切る
  //      （issue #20 レビュー指摘: 正しさ important）
  if (filter?.keyword) query = query.limit(KEYWORD_SCAN_LIMIT)
  else query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  let rows = (data ?? []) as (LoanOrderRow & { loan_order_items?: LoanOrderItemRow[] })[]

  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase()
    rows = rows.filter(o => {
      const procedureMatch = asString(o.procedure_name).toLowerCase().includes(kw)
      const makerMatch = asString(o.maker).toLowerCase().includes(kw)
      const itemMatch = (o.loan_order_items ?? []).some(i => asString(i.name).toLowerCase().includes(kw))
      return procedureMatch || makerMatch || itemMatch
    })
    rows = rows.slice(offset, offset + limit)
  }

  return rows.map(o => ({
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    procedureName: asString(o.procedure_name),
    maker: asString(o.maker),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: (o.loan_order_items ?? []).map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }))
}

export async function createLoanOrder(db: SupabaseClient, facilityId: string, input: LoanOrderInput): Promise<LoanOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await db.rpc('create_loan_order_atomic', {
    p_facility_id: facilityId,
    p_procedure_name: input.procedureName,
    p_maker: input.maker,
    p_items: input.items.map(item => ({
      jan: item.jan ?? null,
      name: item.name,
      quantity: item.quantity,
    })),
  })
  if (error) throw new Error(error.message)

  const o = (data ?? {}) as LoanOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as LoanOrderItemRow[]) : []

  return {
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    procedureName: asString(o.procedure_name),
    maker: asString(o.maker),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
