import { supabase } from '@/lib/supabase/server'
import { asString, asNumber, asNullableNumber } from '@/lib/mapping'
import type { DistributorProduct, DistributorProductInput } from '@/types/distributorProduct'

const DISTRIBUTOR_PRODUCT_COLUMNS =
  'id, product_id, maker, supplier, name, reimbursement_price, quantity, category_id, created_at, updated_at'

interface DistributorProductRow {
  id?: unknown
  product_id?: unknown
  maker?: unknown
  supplier?: unknown
  name?: unknown
  reimbursement_price?: unknown
  quantity?: unknown
  category_id?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapDistributorProduct(row: DistributorProductRow): DistributorProduct {
  return {
    id: asString(row.id),
    productId: asString(row.product_id),
    maker: asString(row.maker),
    supplier: asString(row.supplier),
    name: asString(row.name),
    reimbursementPrice: asNullableNumber(row.reimbursement_price),
    quantity: asNumber(row.quantity),
    categoryId: asString(row.category_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listDistributorProducts(): Promise<DistributorProduct[]> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select(DISTRIBUTOR_PRODUCT_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapDistributorProduct)
}

export async function getDistributorProduct(id: string): Promise<DistributorProduct | null> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select(DISTRIBUTOR_PRODUCT_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function createDistributorProduct(input: DistributorProductInput): Promise<DistributorProduct> {
  const { data, error } = await supabase
    .from('distributor_products')
    .insert({
      product_id: input.productId,
      maker: input.maker,
      supplier: input.supplier,
      name: input.name,
      reimbursement_price: input.reimbursementPrice,
      quantity: input.quantity,
      category_id: input.categoryId,
    })
    .select(DISTRIBUTOR_PRODUCT_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23503') throw new Error(`製品ID "${input.productId}" は存在しません`)
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function updateDistributorProduct(id: string, input: DistributorProductInput): Promise<DistributorProduct> {
  const { data, error } = await supabase
    .from('distributor_products')
    .update({
      product_id: input.productId,
      maker: input.maker,
      supplier: input.supplier,
      name: input.name,
      reimbursement_price: input.reimbursementPrice,
      quantity: input.quantity,
      category_id: input.categoryId,
    })
    .eq('id', id)
    .select(DISTRIBUTOR_PRODUCT_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`代理店商品ID "${id}" は存在しません`)
    if (error.code === '23503') throw new Error(`製品ID "${input.productId}" は存在しません`)
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function deleteDistributorProduct(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('distributor_products')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`代理店商品ID "${id}" は存在しません`)
}
