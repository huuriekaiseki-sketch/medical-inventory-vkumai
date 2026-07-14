import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import { assertValidListOptions } from '@/lib/orders/list-options-validation'
import type { LoanOrder, LoanOrderInput, LoanOrderItem, OrderListFilterOptions } from '@/types/order'

const STATUSES = ['draft', 'submitted'] as const

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

export async function listLoanOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  options?: OrderListFilterOptions
): Promise<LoanOrder[]> {
  assertValidListOptions(limit, offset)
  // issue #20 SET-C: 品名検索（productSearch）は loan_order_items.name を直接使う
  // （name 列がそのまま存在するため products テーブルへのJOINは不要）。
  // 先に対象の loan_order_id 群を絞り込んでからメインクエリに .in() で適用する
  const productSearch = options?.productSearch?.trim()
  let orderIds: string[] | undefined
  if (productSearch) {
    const { data: itemRows, error: itemError } = await db
      .from('loan_order_items')
      .select('loan_order_id')
      .ilike('name', `%${productSearch}%`)
    if (itemError) throw new Error(itemError.message)
    orderIds = Array.from(
      new Set(((itemRows ?? []) as { loan_order_id?: unknown }[]).map(r => asString(r.loan_order_id)))
    )
    if (orderIds.length === 0) return []
  }

  let query = db
    .from('loan_orders')
    .select('*, loan_order_items(*)')
    .eq('facility_id', facilityId)
  if (options?.dateFrom) query = query.gte('created_at', options.dateFrom)
  if (options?.dateTo) query = query.lte('created_at', options.dateTo)
  if (orderIds) query = query.in('id', orderIds)

  // id を第2キーにして同時刻のページング順序も安定させる（case-orders/loan-returnsと統一）
  //
  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel（SET-D）は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(loan_order_items(*))に明示的な
  // ORDER BY を指定しないと代表製品名の選出が理論上非決定的になる。作成順
  // （created_at昇順・id昇順を第2キー）を明示し、「最初に登録した明細」を安定して
  // 代表として選出する
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .order('created_at', { ascending: true, referencedTable: 'loan_order_items' })
    .order('id', { ascending: true, referencedTable: 'loan_order_items' })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (LoanOrderRow & { loan_order_items?: LoanOrderItemRow[] })[]).map(o => ({
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
