import type { SupabaseClient } from '@supabase/supabase-js'

// WHY: 未返却件数 = submittedの短貸発注件数 - returnedの返却件数（施設単位のビジネスルール）
// loan_order_items と loan_return_items に直接の外部キーはないため、件数差分で近似する。
// 差分が負になるケース（返却超過）は0に丸める。
export async function getLoanOutstandingCount(
  db: SupabaseClient,
  facilityId: string
): Promise<number> {
  const { count: submittedCount, error: submittedError } = await db
    .from('loan_orders')
    .select('*', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('status', 'submitted')
  if (submittedError) throw new Error(submittedError.message)

  const { count: returnedCount, error: returnedError } = await db
    .from('loan_returns')
    .select('*', { count: 'exact', head: true })
    .eq('facility_id', facilityId)
    .eq('status', 'returned')
  if (returnedError) throw new Error(returnedError.message)

  const diff = (submittedCount ?? 0) - (returnedCount ?? 0)
  return diff > 0 ? diff : 0
}
