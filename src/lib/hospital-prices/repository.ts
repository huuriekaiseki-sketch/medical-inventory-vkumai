import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber, asNullableNumber } from '@/lib/mapping'
import type { HospitalPrice, HospitalPriceInput } from '@/types/hospitalPrice'

const HOSPITAL_PRICE_COLUMNS =
  'id, distributor_product_id, facility_id, purchase_price, delivery_price, gross_profit, purchase_rate, delivery_rate, created_at, updated_at'

interface HospitalPriceRow {
  id?: unknown
  distributor_product_id?: unknown
  facility_id?: unknown
  purchase_price?: unknown
  delivery_price?: unknown
  gross_profit?: unknown
  purchase_rate?: unknown
  delivery_rate?: unknown
  created_at?: unknown
  updated_at?: unknown
}

export function mapHospitalPrice(row: HospitalPriceRow): HospitalPrice {
  return {
    id: asString(row.id),
    distributorProductId: asString(row.distributor_product_id),
    facilityId: asString(row.facility_id),
    purchasePrice: asNumber(row.purchase_price),
    deliveryPrice: asNumber(row.delivery_price),
    grossProfit: asNumber(row.gross_profit),
    purchaseRate: asNullableNumber(row.purchase_rate),
    deliveryRate: asNullableNumber(row.delivery_rate),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
  }
}

export async function listHospitalPrices(db: SupabaseClient): Promise<HospitalPrice[]> {
  const { data, error } = await db
    .from('hospital_prices')
    .select(HOSPITAL_PRICE_COLUMNS)
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapHospitalPrice)
}

export async function getHospitalPrice(db: SupabaseClient, id: string): Promise<HospitalPrice | null> {
  const { data, error } = await db
    .from('hospital_prices')
    .select(HOSPITAL_PRICE_COLUMNS)
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function createHospitalPrice(db: SupabaseClient, input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await db
    .from('hospital_prices')
    .insert({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .select(HOSPITAL_PRICE_COLUMNS)
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new Error('代理店商品または施設が存在しません')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function updateHospitalPrice(db: SupabaseClient, id: string, input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await db
    .from('hospital_prices')
    .update({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .eq('id', id)
    .select(HOSPITAL_PRICE_COLUMNS)
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`病院別価格ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new Error('代理店商品または施設が存在しません')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function deleteHospitalPrice(db: SupabaseClient, id: string): Promise<void> {
  const { data, error } = await db
    .from('hospital_prices')
    .delete()
    .eq('id', id)
    .select('id')
  if (error) throw new Error(error.message)
  if (data.length === 0) throw new Error(`病院別価格ID "${id}" は存在しません`)
}
