import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'
import { listCaseOrders, createCaseOrder } from '@/lib/case-orders/repository'
import { apiError } from '@/lib/api-error'
import type { CaseOrderInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const db = await createServerSupabase()
  let user
  try { user = await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
  const facilityId = request.nextUrl.searchParams.get('facility_id')
  try {
    await requireFacilityAccess(db, user, facilityId)
  } catch (e) {
    if (e instanceof Error && e.message === 'FACILITY_ID_REQUIRED') return apiError('facility_id は必須です', 400)
    return apiError('アクセス権限がありません', 403)
  }
  const limit = Number(request.nextUrl.searchParams.get('limit') ?? '50')
  const offset = Number(request.nextUrl.searchParams.get('offset') ?? '0')
  try {
    const orders = await listCaseOrders(db, facilityId!, limit, offset)
    return NextResponse.json({ orders })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '発注一覧の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<CaseOrderInput>
  try {
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

  const input: CaseOrderInput = {
    caseDatetime: body.caseDatetime,
    procedureName: body.procedureName,
    patientId: body.patientId,
    patientInitials: body.patientInitials,
    gender: body.gender,
    doctorName: body.doctorName,
    items: body.items ?? [],
  }

  try {
    const db = await createServerSupabase()
    const order = await createCaseOrder(db, body.facilityId, input)
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '発注に失敗しました')
  }
}
