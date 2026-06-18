import { supabase } from '@/lib/supabase/server'
import type { Product, ProductInput } from '@/types/product'

function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    jan: row.jan as string,
    ref: row.ref as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapProduct)
}

export async function getProduct(id: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert({ jan: input.jan, ref: input.ref })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function updateProduct(id: string, input: ProductInput): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .update({ jan: input.jan, ref: input.ref })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`製品ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function deleteProduct(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('products')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`製品ID "${id}" は存在しません`)
}
