import { NextRequest, NextResponse } from 'next/server'
import { listDistributorProducts, createDistributorProduct } from '@/lib/distributor-products/repository'
import { apiError } from '@/lib/api-error'
import type { DistributorProductInput } from '@/types/distributorProduct'

export async function GET() {
  try {
    const items = await listDistributorProducts()
    return NextResponse.json({ items, data: items })
  } catch (error) {
    return apiError(error instanceof Error ? error.message : 'ディーラー商品の取得に失敗しました')
  }
}

export async function POST(request: NextRequest) {
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return apiError('リクエストが不正です', 400)
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.categoryId) {
    return apiError('必須項目が未入力です', 400)
  }

  try {
    const item = await createDistributorProduct(input)
    return NextResponse.json({ item, data: item }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return apiError(error.message, 404)
    }
    return apiError(error instanceof Error ? error.message : 'ディーラー商品の作成に失敗しました')
  }
}
