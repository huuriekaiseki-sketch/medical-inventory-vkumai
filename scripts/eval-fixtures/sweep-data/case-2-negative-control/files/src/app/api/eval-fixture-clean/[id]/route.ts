import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { authGuardError, apiError } from '@/lib/api-error'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  let user
  try {
    user = await requireAuth(db)
  } catch (e) {
    return authGuardError(e)
  }
  const { data, error } = await db
    .from('eval_fixture_clean_items')
    .select('id, facility_id, name')
    .eq('id', id)
    .single()
  if (error) return apiError('取得に失敗しました', 500)
  if (!data) return NextResponse.json({ error: '見つかりません' }, { status: 404 })
  try {
    await requireFacilityAccess(db, user, data.facility_id)
  } catch {
    return apiError('アクセス権限がありません', 403)
  }
  return NextResponse.json({ item: data })
}
