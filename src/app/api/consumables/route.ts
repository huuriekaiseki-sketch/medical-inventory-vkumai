import { NextRequest, NextResponse } from 'next/server'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import type { ConsumableInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const facilityId = request.nextUrl.searchParams.get('facilityId')
  if (!facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  const consumables = await listConsumablesByFacility(facilityId)
  return NextResponse.json({ consumables })
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.name?.trim()) return NextResponse.json({ error: '品名は必須です' }, { status: 400 })
  if (!body.purpose?.trim()) return NextResponse.json({ error: '用途は必須です' }, { status: 400 })

  const consumable = await createConsumable(body.facilityId, {
    name: body.name,
    jan: body.jan,
    purpose: body.purpose,
  })
  return NextResponse.json({ consumable }, { status: 201 })
}
