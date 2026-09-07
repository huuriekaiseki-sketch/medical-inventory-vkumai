import { NextRequest, NextResponse } from 'next/server'
import { createAdminSupabase } from '@/lib/supabase/server'
import { apiError, toClientErrorMessage } from '@/lib/api-error'
import { requireAdmin } from '@/lib/admin-auth'
import { parseBody } from '@/lib/validation/parse-body'
import { userFacilityAssignSchema, userFacilityRemoveSchema } from '@/lib/validation/schemas'

export async function POST(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, userFacilityAssignSchema)
  if (!parsed.ok) return parsed.response
  const { userId, facilityId, role } = parsed.data

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .upsert(
      { user_id: userId, facility_id: facilityId, role: role ?? 'staff' },
      { onConflict: 'user_id,facility_id' }
    )

  if (error) return apiError(toClientErrorMessage(error, '施設の割り当てに失敗しました'))

  return NextResponse.json({ message: '施設を割り当てました' })
}

export async function DELETE(request: NextRequest) {
  const user = await requireAdmin()
  if (!user) return apiError('権限がありません', 403)

  const parsed = await parseBody(request, userFacilityRemoveSchema)
  if (!parsed.ok) return parsed.response
  const { userId, facilityId } = parsed.data

  const admin = createAdminSupabase()
  const { error } = await admin
    .from('user_facilities')
    .delete()
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
  if (error) return apiError(toClientErrorMessage(error, '施設の割り当て解除に失敗しました'))

  return NextResponse.json({ message: '施設の割り当てを解除しました' })
}
