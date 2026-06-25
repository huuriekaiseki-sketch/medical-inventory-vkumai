import { supabase } from '@/lib/supabase/server'
import { asString } from '@/lib/mapping'
import type { Facility, FacilityInput } from '@/types/facility'

const FACILITY_COLUMNS = 'id, name, created_at, updated_at'

interface FacilityRow {
  id?: unknown
  name?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapFacility(row: FacilityRow): Facility {
  return {
    id: asString(row.id),
    name: asString(row.name),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listFacilities(): Promise<Facility[]> {
  const { data, error } = await supabase
    .from('facilities')
    .select(FACILITY_COLUMNS)
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapFacility)
}

export async function getFacility(id: string): Promise<Facility | null> {
  const { data, error } = await supabase
    .from('facilities')
    .select(FACILITY_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function createFacility(input: FacilityInput): Promise<Facility> {
  const { data, error } = await supabase
    .from('facilities')
    .insert({ name: input.name })
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function updateFacility(id: string, input: FacilityInput): Promise<Facility> {
  const { data, error } = await supabase
    .from('facilities')
    .update({ name: input.name })
    .eq('id', id)
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`施設ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function deleteFacility(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('facilities')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`施設ID "${id}" は存在しません`)
}
