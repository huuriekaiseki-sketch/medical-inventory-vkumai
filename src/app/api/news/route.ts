import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listNewsFeed } from '@/lib/news/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'

const DEFAULT_LIMIT = 20
const DEFAULT_OFFSET = 0
const MAX_LIMIT = 100

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

    // Validate limit
    let limit = DEFAULT_LIMIT
    if (limitParam) {
      const parsedLimit = Number(limitParam)
      if (!Number.isFinite(parsedLimit) || parsedLimit < 0) {
        return apiError('limit/offset が不正です', 400)
      }
      if (parsedLimit > MAX_LIMIT) {
        return apiError('limit が不正です', 400)
      }
      limit = parsedLimit
    }

    // Validate offset
    let offset = DEFAULT_OFFSET
    if (offsetParam) {
      const parsedOffset = Number(offsetParam)
      if (!Number.isFinite(parsedOffset) || parsedOffset < 0) {
        return apiError('limit/offset が不正です', 400)
      }
      offset = parsedOffset
    }

    const items = await listNewsFeed(db, { facilityId: grantedFacilityId, limit, offset })
    return NextResponse.json({ items })
  } catch (error) {
    return apiError(toClientErrorMessage(error, 'ニュースの取得に失敗しました'))
  }
}
