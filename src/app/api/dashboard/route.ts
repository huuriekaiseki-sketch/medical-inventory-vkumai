import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { listUserFacilities } from '@/lib/user-facilities/repository'
import { getFacilityOrderSummary } from '@/lib/dashboard/facility-summary'
import { getLoanOutstandingCount } from '@/lib/dashboard/loan-outstanding'
import { listRecentPriceHistories } from '@/lib/price-histories/repository'
import { apiError } from '@/lib/api-error'
import type { DashboardData, DashboardFacilitySummary, LoanOutstandingSummary } from '@/types/dashboard'

export async function GET() {
  try {
    const db = await createServerSupabase()

    let user
    try {
      user = await requireAuth(db)
    } catch {
      return apiError('認証が必要です', 401)
    }

    // WHY: 自分が所属する施設のみを対象にすることで施設間データ隔離を担保する
    // （RLSに加えてアプリ側でも facilityId を絞り込む多層防御）
    const memberships = await listUserFacilities(db, user.id)

    const facilitySummaries: DashboardFacilitySummary[] = await Promise.all(
      memberships.map(async (m) => {
        const summary = await getFacilityOrderSummary(db, m.facilityId)
        return {
          ...summary,
          facilityName: m.facilityName,
        }
      })
    )

    const loanOutstanding: LoanOutstandingSummary[] = await Promise.all(
      memberships.map(async (m) => {
        const outstandingCount = await getLoanOutstandingCount(db, m.facilityId)
        return {
          facilityId: m.facilityId,
          facilityName: m.facilityName,
          outstandingCount,
        }
      })
    )

    const recentPriceChanges = await listRecentPriceHistories(
      db,
      memberships.map((m) => m.facilityId),
      10
    )

    // WHY: role に 'admin' が1件でも含まれれば管理ページショートカットを表示するため
    const isAdmin = memberships.some((m) => m.role === 'admin')

    const data: DashboardData = {
      facilitySummaries,
      loanOutstanding,
      recentPriceChanges,
      isAdmin,
    }

    return NextResponse.json(data)
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'ダッシュボードの取得に失敗しました')
  }
}
