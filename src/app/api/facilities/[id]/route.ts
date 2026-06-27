import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { getFacility, updateFacility, deleteFacility } from '@/lib/facilities/repository'
import type { FacilityInput } from '@/types/facility'
import type { RouteContext } from '@/types/route'

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const db = await createServerSupabase()
  const facility = await getFacility(db, id)
  if (!facility) {
    return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ facility })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.name) {
    return NextResponse.json({ error: '施設名は必須です' }, { status: 400 })
  }

  try {
    const db = await createServerSupabase()
    const facility = await updateFacility(db, id, input)
    return NextResponse.json({ facility })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: '施設名が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    const db = await createServerSupabase()
    await deleteFacility(db, id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
