import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { parseQuery } from '@/lib/validation/parse-query'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { authGuardError, apiError } from '@/lib/api-error'

const shiftNotesQuerySchema = z.object({
  facilityId: z.string().max(200, { error: 'facilityId が長すぎます' }).optional(),
})

export async function GET(request: NextRequest) {
  try {
    const db = await createServerSupabase()
    let user
    try {
      user = await requireAuth(db)
    } catch (e) {
      return authGuardError(e)
    }

    const parsed = parseQuery(request, shiftNotesQuerySchema)
    if (!parsed.ok) return parsed.response

    let grantedFacilityId: string | null
    try {
      ;({ facilityId: grantedFacilityId } = await requireFacilityAccess(
        db,
        user,
        parsed.data.facilityId ?? null
      ))
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') {
        return apiError('facilityId は必須です', 400)
      }
      return apiError('アクセス権限がありません', 403)
    }

    const { data, error } = await db
      .from('facility_shift_notes')
      .select('id, title, body, author_name, created_at')
      .eq('facility_id', grantedFacilityId)
      .order('created_at', { ascending: false })

    if (error) return apiError('取得に失敗しました', 500)

    return NextResponse.json({ items: data ?? [] })
  } catch {
    return apiError('取得に失敗しました', 500)
  }
}
