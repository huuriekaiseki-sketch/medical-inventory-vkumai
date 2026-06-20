import { supabase } from '@/lib/supabase/server'
import type { Category, CategoryInput } from '@/types/category'

function mapCategory(row: Record<string, unknown>): Category {
  return {
    id: row.id as string,
    name: row.name as string,
    description: row.description != null ? (row.description as string) : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapCategory)
}

export async function getCategory(id: string): Promise<Category | null> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function createCategory(input: CategoryInput): Promise<Category> {
  const { data, error } = await supabase
    .from('categories')
    .insert({ name: input.name, description: input.description })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('カテゴリ名が既に使用されています')
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function updateCategory(id: string, input: CategoryInput): Promise<Category> {
  const { data, error } = await supabase
    .from('categories')
    .update({ name: input.name, description: input.description })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`カテゴリID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('カテゴリ名が既に使用されています')
    throw new Error(error.message)
  }
  return mapCategory(data)
}

export async function deleteCategory(id: string): Promise<void> {
  const { count, error: countError } = await supabase
    .from('distributor_products')
    .select('*', { count: 'exact', head: true })
    .eq('category_id', id)
  if (countError) throw new Error(countError.message)
  if ((count ?? 0) > 0) throw new Error('使用中のため削除できません')

  const { data, error } = await supabase
    .from('categories')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`カテゴリID "${id}" は存在しません`)
}
