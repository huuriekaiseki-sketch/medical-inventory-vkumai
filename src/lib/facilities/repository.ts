import { supabase } from '@/lib/supabase/server'
import type { Facility, FacilityInput } from '@/types/facility'

function mapFacility(row: Record<string, unknown>): Facility {
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listFacilities(): Promise<Facility[]> {
  const { data, error } = await supabase
    .from('facilities')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapFacility)
}

export async function getFacility(id: string): Promise<Facility | null> {
  const { data, error } = await supabase
    .from('facilities')
    .select('*')
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
    .select()
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
    .select()
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
