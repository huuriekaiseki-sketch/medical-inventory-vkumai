import { NextRequest, NextResponse } from 'next/server'
import { createCaseOrder } from '@/lib/case-orders/repository'
import type { CaseOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<CaseOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.caseDatetime) return NextResponse.json({ error: '症例日時は必須です' }, { status: 400 })
  if (!body.procedureName?.trim()) return NextResponse.json({ error: '手技名は必須です' }, { status: 400 })
  if (!body.patientId?.trim()) return NextResponse.json({ error: '患者IDは必須です' }, { status: 400 })
  if (!body.patientInitials?.trim()) return NextResponse.json({ error: '患者イニシャルは必須です' }, { status: 400 })
  if (!body.gender) return NextResponse.json({ error: '性別は必須です' }, { status: 400 })
  if (!body.doctorName?.trim()) return NextResponse.json({ error: '担当医師名は必須です' }, { status: 400 })

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
    const order = await createCaseOrder(body.facilityId, input)
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    throw error
  }
}
