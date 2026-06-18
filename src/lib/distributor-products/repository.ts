import { supabase } from '@/lib/supabase/server'
import type { DistributorProduct, DistributorProductInput } from '@/types/distributorProduct'

function mapDistributorProduct(row: Record<string, unknown>): DistributorProduct {
  return {
    id: row.id as string,
    productId: row.product_id as string,
    maker: row.maker as string,
    supplier: row.supplier as string,
    name: row.name as string,
    reimbursementPrice: row.reimbursement_price as number | null,
    quantity: row.quantity as number,
    category: row.category as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listDistributorProducts(): Promise<DistributorProduct[]> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapDistributorProduct)
}

export async function getDistributorProduct(id: string): Promise<DistributorProduct | null> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select('*')
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
      category: input.category,
    })
    .select()
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
      category: input.category,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`代理店商品ID "${id}" は存在しません`)
    if (error.code === '23503') throw new Error(`製品ID "${input.productId}" は存在しません`)
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function deleteDistributorProduct(id: string): Promise<void> {
  const { error } = await supabase
    .from('distributor_products')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
