import type { SupabaseClient } from '@supabase/supabase-js'
import { asString } from '@/lib/mapping'
import { ClientVisibleError } from '@/lib/client-visible-error'
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

export async function listFacilities(db: SupabaseClient): Promise<Facility[]> {
  const { data, error } = await db
    .from('facilities')
    .select(FACILITY_COLUMNS)
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapFacility)
}

export async function getFacility(db: SupabaseClient, id: string): Promise<Facility | null> {
  const { data, error } = await db
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

export async function createFacility(db: SupabaseClient, input: FacilityInput): Promise<Facility> {
  const { data, error } = await db
    .from('facilities')
    .insert({ name: input.name })
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new ClientVisibleError(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function updateFacility(db: SupabaseClient, id: string, input: FacilityInput): Promise<Facility> {
  const { data, error } = await db
    .from('facilities')
    .update({ name: input.name })
    .eq('id', id)
    .select(FACILITY_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new ClientVisibleError(`施設ID "${id}" は存在しません`)
    if (error.code === '23505') throw new ClientVisibleError(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

// WHY(deleteFacility を置かない、2026-09-08・E-055): `facilities` に DELETE の RLS ポリシーが
//      無いので、この関数は誰が呼んでも 0 行になり、それを「存在しません」と読んで
//      **実在する施設に 404 を返していた**。呼び出し元（DELETE route）ごと消した。
//      作り直すときは RLS のポリシーと一緒に作る（片方だけあっても使えない）。
