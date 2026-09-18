import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem } from '@/types/order'
import { toRepositoryError } from '@/lib/invariant-error'
import { ClientVisibleError } from '@/lib/client-visible-error'

// WHY(cancelled、2026-09-08・E-056): 間違えた発注を取り消せるようにした。行は消さず状態で表す
const STATUSES = ['draft', 'submitted', 'cancelled'] as const

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

/** 選べない消耗品（使用停止・他施設）を含む発注。route が 400 に写す（I-035） */
export const CONSUMABLE_NOT_ORDERABLE_ERROR =
  '選べない消耗品が含まれています（使用停止になったか、この施設のものではありません）。一覧を開き直してください'

/**
 * 「選べない消耗品を指した」を DB のエラーから見分ける。
 *
 * WHY(判定を持たずに文言だけ写す): 何が選べるかは RPC（`create_consumable_order_atomic`、
 *      20260909060000）が 1 か所で決めている。アプリ側にも同じ判定を書くと、
 *      **同じ問いの答えが 2 か所にあって食い違う**（E-053）。
 *
 * WHY(コードではなく文言で見分ける): 23514 は業務不変条件すべてに共通で、
 *      それだけだと「入力値が業務ルールに反しています」の汎用文になり、
 *      **一覧を開き直せば直る**ことが伝わらない（C-023: 合図が同じだと層を見分けられない）。
 *
 * WHY(画面を開いたままの競合を想定した文言): 使用停止は他の人が別の画面から行える。
 *      発注フォームを開いたまま停止されると、送信して初めてここに来る。
 *      「一覧を開き直してください」は、その現実に起きる道への案内。
 */
function isNotOrderableViolation(error: { code?: string; message?: string } | null): boolean {
  return error?.code === '23514' && /is not orderable/.test(error.message ?? '')
}

export async function createConsumableOrder(db: SupabaseClient, facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await db.rpc('create_consumable_order_atomic', {
    p_facility_id: facilityId,
    p_items: input.items.map(item => ({
      consumable_id: item.consumableId,
      quantity: item.quantity,
    })),
    // WHY: 鍵が無い呼び出しは引数自体を渡さず、RPC の DEFAULT NULL（毎回新しい行）に任せる（P-053）
    ...(input.clientRequestId ? { p_client_request_id: input.clientRequestId } : {}),
  })
  if (isNotOrderableViolation(error)) throw new ClientVisibleError(CONSUMABLE_NOT_ORDERABLE_ERROR)
  if (error) throw toRepositoryError(error)

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
