import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listCaseOrders, createCaseOrder } from '@/lib/case-orders/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'
import { parsePagination } from '@/lib/api-pagination'
import { validateClientRequestId } from '@/lib/client-request-id'
import type { CaseOrderInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
  const facilityId = request.nextUrl.searchParams.get('facility_id')
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  const pagination = parsePagination(request.nextUrl.searchParams)
  if (!pagination.ok) return pagination.response
  const { limit, offset } = pagination
  try {
    const orders = await listCaseOrders(db, facilityId!, limit, offset)
    return NextResponse.json({ orders })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '発注一覧の取得に失敗しました'))
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<CaseOrderInput>
  try {
    // eslint-disable-next-line no-restricted-syntax -- #757-20 の移行待ち（scripts/lib/input-validation-baseline.json）。parseBody へ移したらこの行を消す
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.caseDatetime) return apiError('症例日時は必須です', 400)
  if (!body.procedureName?.trim()) return apiError('手技名は必須です', 400)
  if (!body.patientId?.trim()) return apiError('患者IDは必須です', 400)
  if (!body.patientInitials?.trim()) return apiError('患者イニシャルは必須です', 400)
  const validGenders = ['male', 'female', 'other']
  if (!body.gender || !validGenders.includes(body.gender)) {
    return apiError('性別は male / female / other のいずれかを指定してください', 400)
  }
  if (!body.doctorName?.trim()) return apiError('担当医師名は必須です', 400)
  const clientRequestId = validateClientRequestId(body.clientRequestId)
  if (!clientRequestId.ok) return apiError(clientRequestId.message, 400)

  const input: CaseOrderInput = {
    caseDatetime: body.caseDatetime,
    procedureName: body.procedureName,
    patientId: body.patientId,
    patientInitials: body.patientInitials,
    gender: body.gender,
    doctorName: body.doctorName,
    items: body.items ?? [],
    clientRequestId: clientRequestId.value,
  }

  try {
    const db = await createServerSupabase()
    let user
    try { user = await requireAuth(db) } catch (e) { return authGuardError(e) }
    try {
      await requireFacilityAccess(db, user, body.facilityId)
    } catch (e) {
      if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('施設IDは必須です', 400)
      return apiError('アクセス権限がありません', 403)
    }
    const order = await createCaseOrder(db, body.facilityId, input)
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    return apiError(toClientErrorMessage(error, '発注に失敗しました'))
  }
}
