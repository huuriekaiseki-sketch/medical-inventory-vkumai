import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber, asNullableNumber, asEnum } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import { KEYWORD_SCAN_LIMIT, type OrderRepositoryFilter } from '@/lib/orders/list-filter'
import type { CaseOrder, CaseOrderInput, CaseOrderItem } from '@/types/order'

const GENDERS = ['male', 'female', 'other'] as const
const STATUSES = ['draft', 'submitted'] as const

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

  return rows.map(o => ({
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
