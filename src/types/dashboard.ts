import type { PriceHistory } from './priceHistory'

/**
 * ユーザーが所属する施設情報（role付き）
 * Set 1: listUserFacilities(db, userId) の戻り値要素の型
 */
export type UserFacilityMembership = {
  facilityId: string
  facilityName: string
  role: 'admin' | 'staff' | 'viewer'
}

/**
 * 施設別 直近発注サマリー（症例・消耗品・貸出の3種）
 * Set 2: getFacilityOrderSummary(db, facilityId) の戻り値
 * 発注が0件の種別は count: 0, latestAt: null
 */
export type DashboardFacilitySummary = {
  facilityId: string
  facilityName: string
  caseOrderCount: number
  caseOrderLatestAt: string | null
  consumableOrderCount: number
  consumableOrderLatestAt: string | null
  loanOrderCount: number
  loanOrderLatestAt: string | null
}

/**
 * 施設別 未返却の貸出件数
 * Set 3: getLoanOutstandingCount(db, facilityId) の集約結果
 * outstandingCount は 0 未満に丸められない（0が下限）
 */
export type LoanOutstandingSummary = {
  facilityId: string
  facilityName: string
  outstandingCount: number
}

/**
 * 最近の価格改定1件分
 * Set 4: listRecentPriceHistories(db, limit) の戻り値要素
 * 既存の PriceHistory 型をそのまま利用（productName を含む）
 */
export type RecentPriceChange = PriceHistory

/**
 * GET /api/dashboard のレスポンス全体
 * Set 5: APIルートが返すペイロード
 * isAdmin: user_facilities の role に 'admin' が1件でも含まれる場合 true
 *          （管理ユーザーページへのショートカット表示に使用）
 */
export type DashboardData = {
  facilitySummaries: DashboardFacilitySummary[]
  loanOutstanding: LoanOutstandingSummary[]
  recentPriceChanges: RecentPriceChange[]
  isAdmin: boolean
}

/**
 * GET /api/dashboard のレスポンス型（成功時）
 */
export type DashboardGetResponse = DashboardData

/**
 * GET /api/dashboard のエラーレスポンス型
 * 401: 未認証, 500: サーバーエラー
 */
export type DashboardErrorResponse = {
  error: string
}
