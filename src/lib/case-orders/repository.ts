import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asEnum } from '@/lib/mapping'
import { assertValidListOptions } from '@/lib/orders/list-options-validation'
import type { CaseOrder, CaseOrderInput, CaseOrderItem, OrderListFilterOptions } from '@/types/order'

const GENDERS = ['male', 'female', 'other'] as const
const STATUSES = ['draft', 'submitted'] as const

interface CaseOrderItemRow {
  id?: unknown
  case_order_id?: unknown
  jan?: unknown
  lot?: unknown
  ubd?: unknown
  quantity?: unknown
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
    createdAt: asString(row.created_at),
  }
}

export async function listCaseOrders(
  db: SupabaseClient,
  facilityId: string,
  limit = 50,
  offset = 0,
  options?: OrderListFilterOptions
): Promise<CaseOrder[]> {
  assertValidListOptions(limit, offset)
  // issue #20 SET-C: 品名検索（productSearch）は case_order_items に name 列が無く、
  // jan → products.name の突合が必要。case_order_items.jan は products.jan への FK では
  // ないため PostgREST の埋め込み(embed) join が使えず、2段階の絞り込みクエリで解決する
  // （① products から該当jan群を取得 → ② case_order_items からその jan群に紐づく
  // case_order_id群を取得 → ③ メインクエリに .in('id', ...) で適用）
  const productSearch = options?.productSearch?.trim()
  let caseOrderIds: string[] | undefined
  if (productSearch) {
    const { data: productRows, error: productError } = await db
      .from('products')
      .select('jan')
      .ilike('name', `%${productSearch}%`)
    if (productError) throw new Error(productError.message)
    const jans = ((productRows ?? []) as { jan?: unknown }[]).map(p => asString(p.jan))
    if (jans.length === 0) return []

    const { data: itemRows, error: itemError } = await db
      .from('case_order_items')
      .select('case_order_id')
      .in('jan', jans)
    if (itemError) throw new Error(itemError.message)
    caseOrderIds = Array.from(
      new Set(((itemRows ?? []) as { case_order_id?: unknown }[]).map(r => asString(r.case_order_id)))
    )
    if (caseOrderIds.length === 0) return []
  }

  let query = db
    .from('case_orders')
    .select('*, case_order_items(*)')
    .eq('facility_id', facilityId)
  if (options?.dateFrom) query = query.gte('case_datetime', options.dateFrom)
  if (options?.dateTo) query = query.lte('case_datetime', options.dateTo)
  if (caseOrderIds) query = query.in('id', caseOrderIds)

  // issue #20 型安全・データ層整合レビュー対応（critical）: dateFrom/dateTo は case_datetime で
  // 絞り込んでいるため、.order() も created_at ではなく case_datetime にしないと、
  // 施設ごとの該当件数が limit を超えた場合に DB 側で誤った基準（created_at）で先に
  // 切り詰められ、unified-repository.ts の fetchTopN が前提とする
  // 「displayDatetime(=case_datetime)降順で上位N件」という不変条件が壊れる。
  // id を第2キーにして同時刻のページング順序も安定させる
  //
  // issue #20 型安全・データ層整合レビュー対応（important）: summaryLabel（SET-D）は
  // items[0]（代表1品目）を使うが、埋め込みクエリ(case_order_items(*))に明示的な
  // ORDER BY を指定しないと代表製品名の選出が理論上非決定的になる。作成順
  // （created_at昇順・id昇順を第2キー）を明示し、「最初に登録した明細」を安定して
  // 代表として選出する
  const { data, error } = await query
    .order('case_datetime', { ascending: false })
    .order('id', { ascending: true })
    .order('created_at', { ascending: true, referencedTable: 'case_order_items' })
    .order('id', { ascending: true, referencedTable: 'case_order_items' })
    .range(offset, offset + limit - 1)
  if (error) throw new Error(error.message)
  return ((data ?? []) as (CaseOrderRow & { case_order_items?: CaseOrderItemRow[] })[]).map(o => ({
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    caseDatetime: asString(o.case_datetime),
    procedureName: asString(o.procedure_name),
    patientId: asString(o.patient_id),
    patientInitials: asString(o.patient_initials),
    gender: asEnum(o.gender, GENDERS, 'other'),
    doctorName: asString(o.doctor_name),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: (o.case_order_items ?? []).map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }))
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
  })
  if (error) throw new Error(error.message)

  const o = (data ?? {}) as CaseOrderRow & { items?: unknown }
  const itemRows = Array.isArray(o.items) ? (o.items as CaseOrderItemRow[]) : []

  return {
    id: asString(o.id),
    facilityId: asString(o.facility_id),
    caseDatetime: asString(o.case_datetime),
    procedureName: asString(o.procedure_name),
    patientId: asString(o.patient_id),
    patientInitials: asString(o.patient_initials),
    gender: asEnum(o.gender, GENDERS, 'other'),
    doctorName: asString(o.doctor_name),
    status: asEnum(o.status, STATUSES, 'draft'),
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
