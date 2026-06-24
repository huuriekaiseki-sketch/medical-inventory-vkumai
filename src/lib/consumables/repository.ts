import { supabase } from '@/lib/supabase/server'
import type { Consumable, ConsumableInput } from '@/types/order'

function mapConsumable(row: Record<string, unknown>): Consumable {
  return {
    id: row.id as string,
    facilityId: row.facility_id as string,
    name: row.name as string,
    jan: row.jan != null ? (row.jan as string) : undefined,
    purpose: row.purpose as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listConsumablesByFacility(facilityId: string): Promise<Consumable[]> {
  const { data, error } = await supabase
    .from('consumables')
    .select('*')
    .eq('facility_id', facilityId)
    .order('purpose', { ascending: true })
  if (error) throw new Error(error.message)
  return (data as Record<string, unknown>[]).map(mapConsumable)
}

export async function createConsumable(facilityId: string, input: ConsumableInput): Promise<Consumable> {
  const { data, error } = await supabase
    .from('consumables')
    .insert({ facility_id: facilityId, name: input.name, jan: input.jan ?? null, purpose: input.purpose })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return mapConsumable(data as Record<string, unknown>)
}
