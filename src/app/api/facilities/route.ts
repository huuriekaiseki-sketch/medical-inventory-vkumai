import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { resolveIsAdmin } from '@/lib/admin-status'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import { listUserFacilities } from '@/lib/user-facilities/repository'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import type { FacilityInput } from '@/types/facility'

export async function GET() {
  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facilities = await listFacilities(db)
    // WHY: フロントエンドが「全施設」表示オプションを出すかどうかの判定に使う。
    // require-facility-access.ts の resolveIsAdmin と同じ判定にすることで、
    // UIが「全施設」を選べるのにAPIがfacilityId必須で弾く、という不整合を防ぐ（issue #40）
    const isAdmin = await resolveIsAdmin(db, user)
    // WHY: viewerロールのUIゲーティング(issue #608)用。施設選択が単一のURLパラメータに
    // 縛られないフォーム(hospital-prices/new等)で、施設ごとに書き込み可否を判定するために
    // 一覧取得と同時にroleも返す。adminはuser_facilitiesに行が無くても書き込めるため、
    // このmapはmembershipがある場合のみ意味を持つ(クライアント側はisAdminを優先して見る)。
    const memberships = await listUserFacilities(db, user.id)
    const roleByFacilityId = Object.fromEntries(memberships.map((m) => [m.facilityId, m.role]))
    return NextResponse.json({ facilities, isAdmin, roleByFacilityId })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '施設の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.name?.trim()) {
    return apiError('施設名は必須です', 400)
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const isAdmin = await resolveIsAdmin(db, user)
    if (!isAdmin) return apiError('権限がありません', 403)
    const facility = await createFacility(db, input)
    return NextResponse.json({ facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('施設名が重複しています', 409)
    }
    return apiError(toClientErrorMessage(error, '施設の作成に失敗しました'))
  }
}
