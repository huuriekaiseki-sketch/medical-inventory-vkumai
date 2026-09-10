import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireFacilityAccess } from '@/lib/security/facility-access'
import { apiError } from '@/lib/api-error'

/**
 * 施設の申し送りメモを一覧で返す。
 * 施設の所属は requireFacilityAccess が確かめる。
 */
export async function GET(request: NextRequest) {
  const facilityId = request.nextUrl.searchParams.get('facilityId')
  if (!facilityId) return apiError('facilityId が必要です', 400)

  const access = await requireFacilityAccess(facilityId)
  if (!access.ok) return apiError(access.message, access.status)

  const db = await createServerSupabase()
  const { data, error } = await db
    .from('eval_fixture_holdout_notes')
    .select('id, title, body, author_name, created_at')
    .eq('facility_id', facilityId)
    .order('created_at', { ascending: false })

  if (error) return apiError('取得に失敗しました', 500)

  return NextResponse.json({ items: data ?? [] })
}
