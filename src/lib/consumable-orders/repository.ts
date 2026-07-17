import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem } from '@/types/order'

const STATUSES = ['draft', 'submitted'] as const

interface ConsumableOrderItemRow {
  id?: unknown
  consumable_order_id?: unknown
  consumable_id?: unknown
  quantity?: unknown
  unit_price?: unknown
  created_at?: unknown
  // keyword絞り込み時のみ nested join で取得される（listConsumableOrders の戻り値には含めない）
  consumables?: { name?: unknown; jan?: unknown } | null
}

// WHY: 重複定義していたフィルタ型を src/lib/orders/list-filter.ts に統合（issue #20 レビュー指摘）
export type ConsumableOrderListFilter = OrderRepositoryFilter

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
    unitPrice: asNullableNumber(row.unit_price),
    createdAt: asString(row.created_at),
  }
}

export async function listConsumableOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  filter?: ConsumableOrderListFilter
): Promise<ConsumableOrder[]> {
  // WHY: consumable_orders 自体には検索対象になる列がない（消耗品名は consumable_id 経由）。
  //      keyword指定時のみ consumables をネストJOINして取得し、既存の戻り値（ConsumableOrder[]）には
  //      影響しない別クエリとして扱う（consumables フィールドはJS側フィルタにのみ使い、mapItemで捨てる）
  const useKeywordQuery = Boolean(filter?.keyword)
  let query = db
    .from('consumable_orders')
    .select(useKeywordQuery ? '*, consumable_order_items(*, consumables(name, jan))' : '*, consumable_order_items(*)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter?.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter?.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))

  // WHY: keywordはconsumables.name/janへのOR一致が要件。DB側で先にrangeすると
  //      キーワード一致前の行に対してoffset/limitを適用してしまうため、
  //      keyword指定時はrangeせず取得してからJS側で判定・スライスする。
  //      無制限取得はDoSベクタになるため created_at 降順 KEYWORD_SCAN_LIMIT 件で打ち切る
  //      （issue #20 レビュー指摘: 正しさ important）
  if (useKeywordQuery) query = query.limit(KEYWORD_SCAN_LIMIT)
  else query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  let rows = (data ?? []) as (ConsumableOrderRow & { consumable_order_items?: ConsumableOrderItemRow[] })[]

  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase()
    rows = rows.filter(o => (o.consumable_order_items ?? []).some(item => {
      const name = asString(item.consumables?.name).toLowerCase()
      const jan = asString(item.consumables?.jan).toLowerCase()
      return name.includes(kw) || jan.includes(kw)
    }))
    rows = rows.slice(offset, offset + limit)
  }

  return rows.map(o => ({
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: (o.consumable_order_items ?? []).map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }))
}

export async function createConsumableOrder(db: SupabaseClient, facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await db.rpc('create_consumable_order_atomic', {
    p_facility_id: facilityId,
    p_items: input.items.map(item => ({
      consumable_id: item.consumableId,
      quantity: item.quantity,
    })),
  })
  if (error) throw new Error(error.message)

  const o = (data ?? {}) as ConsumableOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as ConsumableOrderItemRow[]) : []

  return {
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
