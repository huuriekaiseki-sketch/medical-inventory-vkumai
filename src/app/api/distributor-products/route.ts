import { NextRequest, NextResponse } from 'next/server'
import { listDistributorProducts, createDistributorProduct } from '@/lib/distributor-products/repository'
import type { DistributorProductInput } from '@/types/distributorProduct'

export async function GET() {
  const items = await listDistributorProducts()
  return NextResponse.json({ items })
}

export async function POST(request: NextRequest) {
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.category) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const item = await createDistributorProduct(input)
    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}
