import { NextRequest, NextResponse } from 'next/server'
import { getDistributorProduct, updateDistributorProduct, deleteDistributorProduct } from '@/lib/distributor-products/repository'
import type { DistributorProductInput } from '@/types/distributorProduct'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const item = await getDistributorProduct(id)
  if (!item) {
    return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ item })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
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
    const item = await updateDistributorProduct(id, input)
    return NextResponse.json({ item })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('代理店商品ID')) {
        return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('製品ID')) {
        return NextResponse.json({ error: '指定された製品が見つかりません' }, { status: 404 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteDistributorProduct(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
