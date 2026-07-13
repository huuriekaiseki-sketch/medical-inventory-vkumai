import type { SupabaseClient } from '@supabase/supabase-js'
import { asNullableString, asString } from '@/lib/mapping'
import type { Product, ProductInput } from '@/types/product'

const PRODUCT_COLUMNS = 'id, jan, ref, name, maker, created_at, updated_at'

interface ProductRow {
  id?: unknown
  jan?: unknown
  ref?: unknown
  name?: unknown
  maker?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapProduct(row: ProductRow): Product {
  return {
    id: asString(row.id),
    jan: asString(row.jan),
    ref: asString(row.ref),
    name: asString(row.name),
    maker: asNullableString(row.maker),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listProducts(db: SupabaseClient): Promise<Product[]> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapProduct)
}

export async function getProduct(db: SupabaseClient, id: string): Promise<Product | null> {
  const { data, error } = await db
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function createProduct(db: SupabaseClient, input: ProductInput): Promise<Product> {
  const { data, error } = await db
    .from('products')
    .insert({ jan: input.jan, ref: input.ref, name: input.name, maker: input.maker ?? null })
    .select(PRODUCT_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function updateProduct(db: SupabaseClient, id: string, input: ProductInput): Promise<Product> {
  const { data, error } = await db
    .from('products')
    .update({ jan: input.jan, ref: input.ref, name: input.name, maker: input.maker ?? null })
    .eq('id', id)
    .select(PRODUCT_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`製品ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function deleteProduct(db: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await db
    .from('products')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`製品ID "${id}" は存在しません`)
}
