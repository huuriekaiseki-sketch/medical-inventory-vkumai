import { supabase } from '@/lib/supabase/server'
import { asString, asOptionalString } from '@/lib/mapping'
import type { Consumable, ConsumableInput } from '@/types/order'

const CONSUMABLE_COLUMNS = 'id, facility_id, name, jan, purpose, created_at, updated_at'

interface ConsumableRow {
  id?: unknown
  facility_id?: unknown
  name?: unknown
  jan?: unknown
  purpose?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapConsumable(row: ConsumableRow): Consumable {
  return {
    id: asString(row.id),
    facilityId: asString(row.facility_id),
    name: asString(row.name),
    jan: asOptionalString(row.jan),
    purpose: asString(row.purpose),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listConsumablesByFacility(facilityId: string): Promise<Consumable[]> {
  const { data, error } = await supabase
    .from('consumables')
    .select(CONSUMABLE_COLUMNS)
    .eq('facility_id', facilityId)
    .order('purpose', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapConsumable)
}

export async function createConsumable(facilityId: string, input: ConsumableInput): Promise<Consumable> {
  const { data, error } = await supabase
    .from('consumables')
    .insert({ facility_id: facilityId, name: input.name, jan: input.jan ?? null, purpose: input.purpose })
    .select(CONSUMABLE_COLUMNS)
    .single()
  if (error) throw new Error(error.message)
  return mapConsumable(data)
}
