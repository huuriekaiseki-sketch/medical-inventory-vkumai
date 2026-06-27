import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNullableString } from '@/lib/mapping'
import type { Category, CategoryInput } from '@/types/category'

const CATEGORY_COLUMNS = 'id, name, description, created_at, updated_at'

interface CategoryRow {
  id?: unknown
  name?: unknown
  description?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapCategory(row: CategoryRow): Category {
  return {
    id: asString(row.id),
    name: asString(row.name),
    description: asNullableString(row.description),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listCategories(db: SupabaseClient): Promise<Category[]> {
  const { data, error } = await db
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapCategory)
}

export async function getCategory(db: SupabaseClient, id: string): Promise<Category | null> {
  const { data, error } = await db
    .from('categories')
    .select(CATEGORY_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function createCategory(db: SupabaseClient, input: CategoryInput): Promise<Category> {
  const { data, error } = await db
    .from('categories')
    .insert({ name: input.name, description: input.description })
    .select(CATEGORY_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('カテゴリ名が既に使用されています')
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function updateCategory(db: SupabaseClient, id: string, input: CategoryInput): Promise<Category> {
  const { data, error } = await db
    .from('categories')
    .update({ name: input.name, description: input.description })
    .eq('id', id)
    .select(CATEGORY_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`カテゴリID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('カテゴリ名が既に使用されています')
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function deleteCategory(db: SupabaseClient, id: string): Promise<void> {
  const { count, error: countError } = await db
    .from('distributor_products')
    .select('id', { count: 'exact', head: true })
    .eq('category_id', id)
  if (countError) throw new Error(countError.message)
  if ((count ?? 0) > 0) throw new Error('使用中のため削除できません')

  const { data, error } = await db
    .from('categories')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`カテゴリID "${id}" は存在しません`)
}
