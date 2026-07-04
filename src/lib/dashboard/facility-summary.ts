import type { SupabaseClient } from '@supabase/supabase-js'
import { asString } from '@/lib/mapping'

// WHY: APIルート側でfacilityNameを付与するため、facilityId以外の集計値のみを返す
export type FacilityOrderSummary = {
  facilityId: string
  caseOrderCount: number
  caseOrderLatestAt: string | null
  consumableOrderCount: number
  consumableOrderLatestAt: string | null
  loanOrderCount: number
  loanOrderLatestAt: string | null
}

type CountAndLatest = { count: number; latestAt: string | null }

// WHY: 件数は count:'exact', head:true で軽量に取得し、最新日時は limit=1 の別クエリで取得する
// （1回のクエリで両方取れないため2クエリに分割。データ量が多くなってもcount側はhead:trueで行データを転送しない）
async function getCountAndLatest(
  db: SupabaseClient,
  table: string,
  facilityId: string
): Promise<CountAndLatest> {
  const { count, error: countError } = await db
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
  if (countError) throw new Error(countError.message)

  const { data, error: latestError } = await db
    .from(table)
    .select('created_at')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })
    .limit(1)
  if (latestError) throw new Error(latestError.message)

  const latestRow = ((data ?? []) as { created_at?: unknown }[])[0]
  const latestAt = latestRow?.created_at != null ? asString(latestRow.created_at) : null

  return { count: count ?? 0, latestAt }
}

export async function getFacilityOrderSummary(
  db: SupabaseClient,
  facilityId: string
): Promise<FacilityOrderSummary> {
  const [caseOrders, consumableOrders, loanOrders] = await Promise.all([
    getCountAndLatest(db, 'case_orders', facilityId),
    getCountAndLatest(db, 'consumable_orders', facilityId),
    getCountAndLatest(db, 'loan_orders', facilityId),
  ])

  return {
    facilityId,
    caseOrderCount: caseOrders.count,
    caseOrderLatestAt: caseOrders.latestAt,
    consumableOrderCount: consumableOrders.count,
    consumableOrderLatestAt: consumableOrders.latestAt,
    loanOrderCount: loanOrders.count,
    loanOrderLatestAt: loanOrders.latestAt,
  }
}
