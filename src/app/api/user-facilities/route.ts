import { NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listUserFacilities } from '@/lib/user-facilities/repository'
import { listFacilities } from '@/lib/facilities/repository'
import { apiError } from '@/lib/api-error'

// WHY(issue #20 統合ゲート): /orders ページ(SET-F)は「非adminは自分の所属施設のみを
// 選択肢にする」という受け入れ条件を持つが、既存の GET /api/facilities は
// listFacilities(db) が返す全施設をそのまま返す仕様（施設管理画面向けで、非adminにも
// 全施設が見えても問題ない用途のため）。/orders でこれを使うと非adminにも他施設が
// 選択肢として見えてしまい、初期選択施設が所属外になって403になる不整合が生じる
// （requireFacilityAccess は所属施設のみ許可するため）。
// 既存 GET /api/dashboard は所属施設を正しく絞り込むが、施設サマリー等の重い集計を
// 含み流用に適さないため、施設一覧のみを返す軽量な専用エンドポイントを新設する。
export async function GET() {
  try {
    const db = await createServerSupabase()
    let user
    try {
      user = await requireAuth(db)
    } catch {
      return apiError('認証が必要です', 401)
    }

    const isAdmin = await resolveIsAdmin(db, user)
    const allFacilities = await listFacilities(db)

    if (isAdmin) {
      return NextResponse.json({ facilities: allFacilities, isAdmin: true })
    }

    const memberships = await listUserFacilities(db, user.id)
    const memberFacilityIds = new Set(memberships.map((m) => m.facilityId))
    const facilities = allFacilities.filter((f) => memberFacilityIds.has(f.id))
    return NextResponse.json({ facilities, isAdmin: false })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '施設情報の取得に失敗しました')
  }
}
