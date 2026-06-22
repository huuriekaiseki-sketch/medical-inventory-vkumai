import { NextRequest, NextResponse } from 'next/server'
import { getPriceHistory } from '@/lib/price-histories/repository'
import { getDistributorProduct } from '@/lib/distributor-products/repository'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const product = await getDistributorProduct(id)
    if (!product) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }

    const items = await getPriceHistory(id)
    return NextResponse.json({ items })
  } catch (err) {
    const message = err instanceof Error ? err.message : '不明なエラー'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
