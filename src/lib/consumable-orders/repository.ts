import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber, asEnum } from '@/lib/mapping'
import { assertValidListOptions } from '@/lib/orders/list-options-validation'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem, OrderListFilterOptions } from '@/types/order'

const STATUSES = ['draft', 'submitted'] as const

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

export async function listConsumableOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  options?: OrderListFilterOptions
): Promise<ConsumableOrder[]> {
  assertValidListOptions(limit, offset)
  // issue #20 SET-C: 品名検索（productSearch）は consumable_order_items に name 列が無く、
  // consumable_id → consumables.name の突合が必要。2段階の絞り込みクエリで解決する
  // （① consumables から施設内で該当する消耗品群を取得 → ② consumable_order_items から
  // その consumable_id群に紐づく consumable_order_id群を取得 → ③ メインクエリに適用）
  const productSearch = options?.productSearch?.trim()
  let orderIds: string[] | undefined
  if (productSearch) {
    const { data: consumableRows, error: consumableError } = await db
      .from('consumables')
      .select('id')
      .eq('facility_id', facilityId)
      .ilike('name', `%${productSearch}%`)
    if (consumableError) throw new Error(consumableError.message)
    const consumableIds = ((consumableRows ?? []) as { id?: unknown }[]).map(c => asString(c.id))
    if (consumableIds.length === 0) return []

    const { data: itemRows, error: itemError } = await db
      .from('consumable_order_items')
      .select('consumable_order_id')
      .in('consumable_id', consumableIds)
    if (itemError) throw new Error(itemError.message)
    orderIds = Array.from(
      new Set(((itemRows ?? []) as { consumable_order_id?: unknown }[]).map(r => asString(r.consumable_order_id)))
    )
    if (orderIds.length === 0) return []
  }

  let query = db
    .from('consumable_orders')
    .select('*, consumable_order_items(*)')
    .eq('facility_id', facilityId)
  if (options?.dateFrom) query = query.gte('created_at', options.dateFrom)
  if (options?.dateTo) query = query.lte('created_at', options.dateTo)
  if (orderIds) query = query.in('id', orderIds)

  // id を第2キーにして同時刻のページング順序も安定させる（case-orders/loan-returnsと統一）
  //
  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel（SET-D）は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(consumable_order_items(*))に明示的な
  // ORDER BY を指定しないと代表製品名の選出が理論上非決定的になる。作成順
  // （created_at昇順・id昇順を第2キー）を明示し、「最初に登録した明細」を安定して
  // 代表として選出する
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: true })
    .order('created_at', { ascending: true, referencedTable: 'consumable_order_items' })
    .order('id', { ascending: true, referencedTable: 'consumable_order_items' })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (ConsumableOrderRow & { consumable_order_items?: ConsumableOrderItemRow[] })[]).map(o => ({
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
