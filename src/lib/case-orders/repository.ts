import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { CaseOrder, CaseOrderInput, CaseOrderItem } from '@/types/order'
import { toRepositoryError } from '@/lib/invariant-error'

const GENDERS = ['male', 'female', 'other'] as const
// WHY(cancelled、2026-09-08・E-056): 間違えた発注を取り消せるようにした。行は消さず状態で表す
const STATUSES = ['draft', 'submitted', 'cancelled'] as const

interface CaseOrderItemRow {
  id?: unknown
  case_order_id?: unknown
  jan?: unknown
  lot?: unknown
  ubd?: unknown
  quantity?: unknown
  unit_price?: unknown
  created_at?: unknown
}

interface CaseOrderRow {
  id?: unknown
  facility_id?: unknown
  case_datetime?: unknown
  procedure_name?: unknown
  patient_id?: unknown
  patient_initials?: unknown
  gender?: unknown
  doctor_name?: unknown
  status?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapItem(row: CaseOrderItemRow): CaseOrderItem {
  return {
    id: asString(row.id),
    caseOrderId: asString(row.case_order_id),
    jan: asString(row.jan),
    lot: asOptionalString(row.lot),
    ubd: asOptionalString(row.ubd),
    quantity: asNumber(row.quantity),
    unitPrice: asNullableNumber(row.unit_price),
    createdAt: asString(row.created_at),
  }
}

// WHY(issue #809 Set A): 一覧・作成・単体取得の3箇所で同じ行→型の写しを書いていたのを
//      1つに統合する（SPEC.md Part2「同じ写しを2か所に書かない」）。明細行は呼び出し元が
//      抽出してから渡す（ネストのキー名が listCaseOrders は case_order_items、
//      createCaseOrder の RPC 応答は items と異なるため）
export function mapCaseOrder(row: CaseOrderRow, itemRows: CaseOrderItemRow[]): CaseOrder {
  return {
    id: asString(row.id),
    facilityId: asString(row.facility_id),
    caseDatetime: asString(row.case_datetime),
    procedureName: asString(row.procedure_name),
    patientId: asString(row.patient_id),
    patientInitials: asString(row.patient_initials),
    gender: asEnum(row.gender, GENDERS, 'other'),
    doctorName: asString(row.doctor_name),
    status: asEnum(row.status, STATUSES, 'draft'),
    items: itemRows.map(mapItem),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

// WHY: 重複定義していたフィルタ型を src/lib/orders/list-filter.ts に統合（issue #20 レビュー指摘）
export type CaseOrderListFilter = OrderRepositoryFilter

export async function listCaseOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  filter?: CaseOrderListFilter
): Promise<CaseOrder[]> {
  let query = db
    .from('case_orders')
    .select('*, case_order_items(*)')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (filter?.dateFrom) query = query.gte('created_at', jstDayStart(filter.dateFrom))
  if (filter?.dateTo) query = query.lte('created_at', jstDayEnd(filter.dateTo))

  // WHY: keyword は procedure_name と items[].jan の OR一致が要件。
  //      DB側のilikeだけではAND条件になり item のみ一致する行を取りこぼすため、
  //      keyword指定時はDB側でrangeせず取得してからJS側でOR一致判定し、
  //      その後にoffset/limitを適用する（filter未指定時は従来通りDB側でrangeする）。
  //      ただし無制限取得はDoSベクタになるため created_at 降順 KEYWORD_SCAN_LIMIT 件で
  //      打ち切る（issue #20 レビュー指摘: 正しさ important）
  if (filter?.keyword) query = query.limit(KEYWORD_SCAN_LIMIT)
  else query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw new Error(error.message)
  let rows = (data ?? []) as (CaseOrderRow & { case_order_items?: CaseOrderItemRow[] })[]

  if (filter?.keyword) {
    const kw = filter.keyword.toLowerCase()
    rows = rows.filter(o => {
      const procedureMatch = asString(o.procedure_name).toLowerCase().includes(kw)
      const itemMatch = (o.case_order_items ?? []).some(i => asString(i.jan).toLowerCase().includes(kw))
      return procedureMatch || itemMatch
    })
    rows = rows.slice(offset, offset + limit)
  }

  return rows.map(o => mapCaseOrder(o, o.case_order_items ?? []))
}

/**
 * 1件取得（issue #809 Set A、詳細ページ用）。
 *
 * WHY(施設IDを引数に取らない「先引き」): SPEC.md Part2で、repository と route の認可の形が
 *      両立しない2案で書かれていた指摘を受け、先引きに統一した。見つからない（存在しない・
 *      RLSで見えない）場合はnullを返すだけで、施設境界の判定はroute側の
 *      requireFacilityAccess(db, user, record.facilityId) に委ねる。
 *
 * WHY(maybeSingle): 0件はエラーではなくnullとして扱いたい（RLSで見えない行を「存在しない」と
 *      区別しない。存在の有無を漏らさないため）。single()だとPGRST116をエラー分岐で
 *      拾う必要があり、コードが1つ増える分だけ間違えやすい。
 */
export async function getCaseOrder(db: SupabaseClient, id: string): Promise<CaseOrder | null> {
  const { data, error } = await db
    .from('case_orders')
    .select('*, case_order_items(*)')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as CaseOrderRow & { case_order_items?: CaseOrderItemRow[] }
  return mapCaseOrder(row, row.case_order_items ?? [])
}

export async function createCaseOrder(db: SupabaseClient, facilityId: string, input: CaseOrderInput): Promise<CaseOrder> {
  // 単一トランザクションで完結させるため RPC を呼ぶ（ヘッダー+明細を原子的に INSERT）
  const { data, error } = await db.rpc('create_case_order_atomic', {
    p_facility_id: facilityId,
    p_case_datetime: input.caseDatetime,
    p_procedure_name: input.procedureName,
    p_patient_id: input.patientId,
    p_patient_initials: input.patientInitials,
    p_gender: input.gender,
    p_doctor_name: input.doctorName,
    p_items: input.items.map(item => ({
      jan: item.jan,
      lot: item.lot ?? null,
      ubd: item.ubd ?? null,
      quantity: item.quantity,
    })),
    // WHY: 鍵が無い呼び出しは引数自体を渡さず、RPC の DEFAULT NULL（毎回新しい行）に任せる（P-053）
    ...(input.clientRequestId ? { p_client_request_id: input.clientRequestId } : {}),
  })
  if (error) throw toRepositoryError(error)

  const o = (data ?? {}) as CaseOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as CaseOrderItemRow[]) : []

  return mapCaseOrder(o, itemRows)
}
