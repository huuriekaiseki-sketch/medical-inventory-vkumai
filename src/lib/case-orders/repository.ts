import { supabase } from '@/lib/supabase/server'
import type { CaseOrder, CaseOrderInput, CaseOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): CaseOrderItem {
  return {
    id: row.id as string,
    caseOrderId: row.case_order_id as string,
    jan: row.jan as string,
    lot: row.lot != null ? (row.lot as string) : undefined,
    ubd: row.ubd != null ? (row.ubd as string) : undefined,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createCaseOrder(facilityId: string, input: CaseOrderInput): Promise<CaseOrder> {
  const { data: order, error: orderError } = await supabase
    .from('case_orders')
    .insert({
      facility_id: facilityId,
      case_datetime: input.caseDatetime,
      procedure_name: input.procedureName,
      patient_id: input.patientId,
      patient_initials: input.patientInitials,
      gender: input.gender,
      doctor_name: input.doctorName,
    })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const itemRows = input.items.map(item => ({
    case_order_id: (order as Record<string, unknown>).id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('case_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  const o = order as Record<string, unknown>
  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    caseDatetime: o.case_datetime as string,
    procedureName: o.procedure_name as string,
    patientId: o.patient_id as string,
    patientInitials: o.patient_initials as string,
    gender: o.gender as 'male' | 'female' | 'other',
    doctorName: o.doctor_name as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
