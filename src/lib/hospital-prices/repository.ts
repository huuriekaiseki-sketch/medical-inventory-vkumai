import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNumber, asNullableNumber } from '@/lib/mapping'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { toRepositoryError } from '@/lib/invariant-error'
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

// facilityId が null の場合は絞り込みなし（admin の全施設閲覧用）。
// 非adminはAPI層の requireFacilityAccess で facilityId が必須になるため、必ず絞り込まれる
export async function listHospitalPrices(
  db: SupabaseClient,
  facilityId: string | null = null
): Promise<HospitalPrice[]> {
  let query = db.from('hospital_prices').select(HOSPITAL_PRICE_COLUMNS)
  if (facilityId) query = query.eq('facility_id', facilityId)
  const { data, error } = await query.order('created_at', { ascending: false })
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
    if (error.code === '23505') throw new ClientVisibleError('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new ClientVisibleError('代理店商品または施設が存在しません')
    throw toRepositoryError(error)
  }
  return mapHospitalPrice(data)
}

export const HOSPITAL_PRICE_CONFLICT_MESSAGE =
  '他の利用者が先に更新または削除しました。最新の内容を読み込み直してから再度保存してください'

export async function updateHospitalPrice(db: SupabaseClient, id: string, input: HospitalPriceInput): Promise<HospitalPrice> {
  // WHY(P-052 楽観ロック): 同じ価格行を 2 人が同時に開いて保存すると、後から保存した側が
  //      相手の変更を黙って上書きする（lost update）。読み込み時の updated_at を WHERE に入れ、
  //      一致する行だけを更新する。updated_at は BEFORE UPDATE トリガーが毎回 now() にするので、
  //      誰かが先に更新していれば一致せず 0 行 → PGRST116 になり、それを競合として返す。
  //      値は API が返した文字列をそのまま送り返す（Date に変換するとマイクロ秒が落ちて一致しない）。
  let query = db
    .from('hospital_prices')
    .update({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .eq('id', id)
  if (input.expectedUpdatedAt) query = query.eq('updated_at', input.expectedUpdatedAt)
  const { data, error } = await query.select(HOSPITAL_PRICE_COLUMNS).single()
  if (error) {
    if (error.code === 'PGRST116' && input.expectedUpdatedAt) throw new ClientVisibleError(HOSPITAL_PRICE_CONFLICT_MESSAGE)
    if (error.code === 'PGRST116') throw new ClientVisibleError(`病院別価格ID "${id}" は存在しません`)
    if (error.code === '23505') throw new ClientVisibleError('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new ClientVisibleError('代理店商品または施設が存在しません')
    throw toRepositoryError(error)
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
  if (data.length === 0) throw new ClientVisibleError(`病院別価格ID "${id}" は存在しません`)
}
