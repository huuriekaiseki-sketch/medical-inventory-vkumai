import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { LoanOrder, LoanOrderInput, LoanOrderItem } from '@/types/order'
import { toRepositoryError } from '@/lib/invariant-error'

const STATUSES = ['draft', 'submitted'] as const

interface LoanOrderItemRow {
  id?: unknown
  loan_order_id?: unknown
  jan?: unknown
  name?: unknown
  quantity?: unknown
  unit_price?: unknown
  created_at?: unknown
  // WHY(2026-09-08): 分割返却の残数を出すために、この明細へ紐付いた返却の数量を埋め込む
  loan_return_items?: { quantity?: unknown }[]
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
    // 埋め込みが無い呼び出し（古い select）では 0 になる。残り = quantity - returnedQuantity
    returnedQuantity: (row.loan_return_items ?? []).reduce((n, r) => n + asNumber(r.quantity), 0),
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
    // WHY(2026-09-08): 返却フォームが明細ごとの残数を出すため、紐付いた返却の数量まで取る
    .select('*, loan_order_items(*, loan_return_items(quantity))')
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
    // WHY: 鍵が無い呼び出しは引数自体を渡さず、RPC の DEFAULT NULL（毎回新しい行）に任せる（P-053）
    ...(input.clientRequestId ? { p_client_request_id: input.clientRequestId } : {}),
  })
  if (error) throw toRepositoryError(error)

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
