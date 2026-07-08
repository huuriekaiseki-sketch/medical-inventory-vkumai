import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listNewsFeed } from '@/lib/news/repository'
import { apiError } from '@/lib/api-error'

const DEFAULT_LIMIT = 20
const DEFAULT_OFFSET = 0

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }

    const facilityId = request.nextUrl.searchParams.get('facilityId')
    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(db, user, facilityId))
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facilityId は必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }

    const limitParam = request.nextUrl.searchParams.get('limit')
    const offsetParam = request.nextUrl.searchParams.get('offset')
    const limit = limitParam ? Number(limitParam) : DEFAULT_LIMIT
    const offset = offsetParam ? Number(offsetParam) : DEFAULT_OFFSET

    const items = await listNewsFeed(db, { facilityId: grantedFacilityId, limit, offset })
    return NextResponse.json({ items })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'ニュースの取得に失敗しました')
  }
}
