import { NextRequest, NextResponse } from 'next/server'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import type { FacilityInput } from '@/types/facility'

export async function GET() {
  const facilities = await listFacilities()
  return NextResponse.json({ facilities })
}

export async function POST(request: NextRequest) {
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
    const facility = await createFacility(input)
    return NextResponse.json({ facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: '施設名が重複しています' }, { status: 409 })
    }
    throw error
  }
}
