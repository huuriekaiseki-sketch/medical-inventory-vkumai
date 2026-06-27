import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import { apiError } from '@/lib/api-error'
import type { ConsumableInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const facilityId = request.nextUrl.searchParams.get('facilityId')
  if (!facilityId) return apiError('施設IDは必須です', 400)
  try {
    const db = await createServerSupabase()
    const consumables = await listConsumablesByFacility(db, facilityId)
    return NextResponse.json({ consumables, data: consumables })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '消耗品の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableInput>
  try {
    body = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }
  if (!body.facilityId) return apiError('施設IDは必須です', 400)
  if (!body.name?.trim()) return apiError('品名は必須です', 400)
  if (!body.purpose?.trim()) return apiError('用途は必須です', 400)

  try {
    const db = await createServerSupabase()
    const consumable = await createConsumable(db, body.facilityId, {
      name: body.name,
      jan: body.jan,
      purpose: body.purpose,
    })
    return NextResponse.json({ consumable, data: consumable }, { status: 201 })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : '消耗品の作成に失敗しました')
  }
}
