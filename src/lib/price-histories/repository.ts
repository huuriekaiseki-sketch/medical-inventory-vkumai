import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asEnum, asNullableString, asNullableNumber } from '@/lib/mapping'
import type { PriceHistory, PriceHistoryEntityType, PriceHistoryFieldName } from '@/types/priceHistory'

const ENTITY_TYPES = ['distributor_product', 'hospital_price'] as const satisfies readonly PriceHistoryEntityType[]
const FIELD_NAMES = ['reimbursement_price', 'purchase_price', 'delivery_price'] as const satisfies readonly PriceHistoryFieldName[]

interface PriceHistoryRow {
  id?: unknown
  entity_type?: unknown
  entity_id?: unknown
  dist_product_id?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
  changed_at?: unknown
  facility_name?: unknown
}

interface RecentPriceHistoryRow {
  id?: unknown
  entity_type?: unknown
  entity_id?: unknown
  distributor_product_id?: unknown
  field_name?: unknown
  old_value?: unknown
  new_value?: unknown
  changed_at?: unknown
  distributor_products?: { name?: unknown } | null
}

/**
 * RPC行をPriceHistory型にマッピングする
 * DBカラム名（snake_case）をTypeScript型（camelCase）に変換
 * 特に dist_product_id を distributorProductId にマップ
 */
export function mapPriceHistory(row: PriceHistoryRow): PriceHistory {
  return {
    id: asString(row.id),
    entityType: asString(row.entity_type) as PriceHistoryEntityType,
    entityId: asString(row.entity_id),
    distributorProductId: asString(row.dist_product_id),
    fieldName: asString(row.field_name) as PriceHistoryFieldName,
    oldValue: asNullableNumber(row.old_value),
    newValue: asNullableNumber(row.new_value),
    changedAt: asString(row.changed_at),
    facilityName: asNullableString(row.facility_name),
  }
}

export async function getPriceHistory(db: SupabaseClient, distributorProductId: string): Promise<PriceHistory[]> {
  const { data, error } = await db.rpc(
    'get_distributor_product_price_history',
    { p_distributor_product_id: distributorProductId }
  )
  if (error) throw new Error(error.message)
  return ((data as PriceHistoryRow[] | null) ?? []).map(mapPriceHistory)
}

/**
 * RPC行（全体横断クエリ用）を PriceHistory 型にマッピングする
 * distributor_products を JOIN し productName を埋める（ダッシュボード表示用）
 * facilityName はこのクエリでは取得しないため常に null（既存の単一商品ページ側で別途利用）
 */
export function mapRecentPriceHistory(row: RecentPriceHistoryRow): PriceHistory {
  return {
    id: asString(row.id),
    entityType: asEnum(row.entity_type, ENTITY_TYPES, 'distributor_product'),
    entityId: asString(row.entity_id),
    distributorProductId: asString(row.distributor_product_id),
    fieldName: asEnum(row.field_name, FIELD_NAMES, 'reimbursement_price'),
    oldValue: asNullableNumber(row.old_value),
    newValue: asNullableNumber(row.new_value),
    changedAt: asString(row.changed_at),
    facilityName: null,
    productName: asNullableString(row.distributor_products?.name),
  }
}

// WHY: price_histories.entity_id は hospital_prices への実FKではない（ポリモーフィック列）ため
// Supabaseの埋め込みJOINが使えない。hospital_price行だけ facility_id を別クエリで引いて
// allowedFacilityIds に絞り込む（distributor_product行は施設非依存の商品マスタ変更なので対象外）。
const FETCH_MULTIPLIER = 3

/**
 * 全体横断の最近の価格改定を changed_at 降順で最大 limit 件取得する
 * Set 4: ダッシュボードの「最近の価格改定」セクション向け
 * hospital_price 行は allowedFacilityIds に含まれる施設のもののみ返す（アプリ層の多層防御。RLSに加えて絞り込む）
 */
export async function listRecentPriceHistories(
  db: SupabaseClient,
  allowedFacilityIds: string[],
  limit = 10
): Promise<PriceHistory[]> {
  const { data, error } = await db
    .from('price_histories')
    .select('id, entity_type, entity_id, distributor_product_id, field_name, old_value, new_value, changed_at, distributor_products(name)')
    .order('changed_at', { ascending: false })
    .limit(limit * FETCH_MULTIPLIER)
  if (error) throw new Error(error.message)

  const rows = (data ?? []) as unknown as RecentPriceHistoryRow[]

  const hospitalPriceEntityIds = [
    ...new Set(
      rows
        .filter((row) => asEnum(row.entity_type, ENTITY_TYPES, 'distributor_product') === 'hospital_price')
        .map((row) => asString(row.entity_id))
        .filter((id) => id !== '')
    ),
  ]

  const facilityIdByHospitalPriceId = new Map<string, string>()
  if (hospitalPriceEntityIds.length > 0) {
    const { data: hospitalPriceRows, error: hpError } = await db
      .from('hospital_prices')
      .select('id, facility_id')
      .in('id', hospitalPriceEntityIds)
    if (hpError) throw new Error(hpError.message)
    for (const row of (hospitalPriceRows ?? []) as { id?: unknown; facility_id?: unknown }[]) {
      facilityIdByHospitalPriceId.set(asString(row.id), asString(row.facility_id))
    }
  }

  const allowed = new Set(allowedFacilityIds)

  return rows
    .filter((row) => {
      const entityType = asEnum(row.entity_type, ENTITY_TYPES, 'distributor_product')
      if (entityType === 'distributor_product') return true
      const facilityId = facilityIdByHospitalPriceId.get(asString(row.entity_id))
      return facilityId !== undefined && allowed.has(facilityId)
    })
    .slice(0, limit)
    .map(mapRecentPriceHistory)
}
