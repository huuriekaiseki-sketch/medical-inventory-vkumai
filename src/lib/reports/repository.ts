import type { SupabaseClient } from '@supabase/supabase-js'
import { asString, asNullableNumber, asNumber } from '@/lib/mapping'
import { jstDayStart, jstDayEnd } from '@/lib/jst-date-range'
import type { OrderAmountReportRow, OrderAmountReportFilter } from '@/types/report'

interface OrderAmountReportRpcRow {
  facility_id?: unknown
  facility_name?: unknown
  case_order_amount?: unknown
  case_order_count?: unknown
  case_order_total_count?: unknown
  consumable_order_amount?: unknown
  consumable_order_count?: unknown
  consumable_order_total_count?: unknown
  loan_order_amount?: unknown
  loan_order_count?: unknown
  loan_order_total_count?: unknown
}

function mapRow(row: OrderAmountReportRpcRow): OrderAmountReportRow {
  return {
    facilityId: asString(row.facility_id),
    facilityName: asString(row.facility_name),
    caseOrderAmount: asNullableNumber(row.case_order_amount),
    caseOrderCount: asNumber(row.case_order_count),
    caseOrderTotalCount: asNumber(row.case_order_total_count),
    consumableOrderAmount: asNullableNumber(row.consumable_order_amount),
    consumableOrderCount: asNumber(row.consumable_order_count),
    consumableOrderTotalCount: asNumber(row.consumable_order_total_count),
    loanOrderAmount: asNullableNumber(row.loan_order_amount),
    loanOrderCount: asNumber(row.loan_order_count),
    loanOrderTotalCount: asNumber(row.loan_order_total_count),
  }
}

/**
 * 施設別×発注種別の発注金額集計を取得する（issue #23 分析・レポートページ）。
 * dateFrom/dateTo（YYYY-MM-DD）は jstDayStart/jstDayEnd でJST日境界のTIMESTAMPTZに変換してから
 * RPC(get_order_amount_report)へ渡す。RPC側でis_admin()チェックがあり、非adminの場合は
 * permission deniedエラーになる（API層(route.ts)で403に変換する想定。ここではそのままthrowする）。
 */
export async function fetchOrderAmountReport(
  db: SupabaseClient,
  filter: OrderAmountReportFilter
): Promise<OrderAmountReportRow[]> {
  const { data, error } = await db.rpc('get_order_amount_report', {
    p_date_from: filter.dateFrom ? jstDayStart(filter.dateFrom) : null,
    p_date_to: filter.dateTo ? jstDayEnd(filter.dateTo) : null,
  })
  if (error) throw new Error(error.message)

  return ((data ?? []) as OrderAmountReportRpcRow[]).map(mapRow)
}
