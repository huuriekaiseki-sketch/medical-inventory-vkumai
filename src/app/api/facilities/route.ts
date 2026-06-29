import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import { apiError } from '@/lib/api-error'
import type { FacilityInput } from '@/types/facility'

export async function GET() {
  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facilities = await listFacilities(db)
    return NextResponse.json({ facilities })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '施設の取得に失敗しました')
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
    try { await requireAuth(db) } catch { return apiError('認証が必要です', 401) }
    const facility = await createFacility(db, input)
    return NextResponse.json({ facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return apiError('施設名が重複しています', 409)
    }
    return apiError(error instanceof Error ? error.message : '施設の作成に失敗しました')
  }
}
