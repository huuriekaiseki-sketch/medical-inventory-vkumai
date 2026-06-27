import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asOptionalString, asNumber } from '@/lib/mapping'
import type { CaseOrder, CaseOrderInput, CaseOrderItem } from '@/types/order'

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
    p_items: JSON.stringify(
      input.items.map(item => ({
        jan: item.jan,
        lot: item.lot ?? null,
        ubd: item.ubd ?? null,
        quantity: item.quantity,
      }))
    ),
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
    gender: asString(o.gender) as 'male' | 'female' | 'other',
    doctorName: asString(o.doctor_name),
    status: asString(o.status) as 'draft' | 'submitted',
    items: itemRows.map(mapItem),
    createdAt: asString(o.created_at),
    updatedAt: asString(o.updated_at),
  }
}
