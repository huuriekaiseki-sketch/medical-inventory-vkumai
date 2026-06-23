import { supabase } from '@/lib/supabase/server'
import type { HospitalPrice, HospitalPriceInput } from '@/types/hospitalPrice'

function mapHospitalPrice(row: Record<string, unknown>): HospitalPrice {
  return {
    id: row.id as string,
    distributorProductId: row.distributor_product_id as string,
    facilityId: row.facility_id as string,
    purchasePrice: Number(row.purchase_price),
    deliveryPrice: Number(row.delivery_price),
    grossProfit: Number(row.gross_profit),
    purchaseRate: row.purchase_rate != null ? Number(row.purchase_rate) : null,
    deliveryRate: row.delivery_rate != null ? Number(row.delivery_rate) : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listHospitalPrices(): Promise<HospitalPrice[]> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapHospitalPrice)
}

export async function getHospitalPrice(id: string): Promise<HospitalPrice | null> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function createHospitalPrice(input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .insert({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new Error('代理店商品または施設が存在しません')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function updateHospitalPrice(id: string, input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .update({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`病院別価格ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new Error('代理店商品または施設が存在しません')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function deleteHospitalPrice(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`病院別価格ID "${id}" は存在しません`)
}
