/**
 * 分析・レポートページ（issue #23）
 * Set C: `get_order_amount_report` RPC の戻り値をキャメルケース化した型
 */
export type OrderAmountReportRow = {
  facilityId: string
  facilityName: string
  /** NULL: 発注はあるが単価データなし（未解決事項4）。0円は number の 0 として区別される */
  caseOrderAmount: number | null
  /** 単価データがある明細の件数（金額集計に使われた件数。0件だけでは「発注0件」と区別できないため caseOrderTotalCount と併用する） */
  caseOrderCount: number
  /**
   * 価格の有無を問わない全明細件数。0 なら「発注自体が0件」、0より大きく caseOrderAmount が
   * null なら「発注はあるが単価データなし」と判定できる（レビュー指摘: critical
   * 「発注0件と単価データなしの区別ができない」への対応。SPEC.md Part2 Set B参照）
   */
  caseOrderTotalCount: number
  consumableOrderAmount: number | null
  consumableOrderCount: number
  consumableOrderTotalCount: number
  loanOrderAmount: number | null
  loanOrderCount: number
  loanOrderTotalCount: number
}

/**
 * Set C: fetchOrderAmountReport の filter 引数 / Set D: APIクエリパラメータの由来
 * dateFrom/dateTo は YYYY-MM-DD（JST日境界への変換は repository 側の責務。
 * `src/lib/jst-date-range.ts` の jstDayStart/jstDayEnd を再利用する）
 */
export type OrderAmountReportFilter = {
  dateFrom?: string
  dateTo?: string
}

/**
 * GET /api/admin/reports のクエリパラメータ（パース・バリデーション後の型）
 * Set D: date_from/date_to は isValidDateString() でYYYY-MM-DD形式チェック済み、
 * dateFrom > dateTo でないことを route 側で検証済みとする
 */
export type OrderAmountReportApiQuery = OrderAmountReportFilter

/**
 * GET /api/admin/reports のレスポンス型（成功時）
 * Set D: route.ts が返すペイロード
 */
export type OrderAmountReportApiResponse = {
  rows: OrderAmountReportRow[]
}

/**
 * GET /api/admin/reports のエラーレスポンス型
 * 400: date_from/date_to 形式不正・dateFrom > dateTo, 401: 未認証, 403: 非admin, 500: サーバーエラー
 */
export type OrderAmountReportApiErrorResponse = {
  error: string
}
