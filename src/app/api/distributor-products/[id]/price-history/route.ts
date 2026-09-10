import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabase } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/supabase/require-auth'
import { getPriceHistory } from '@/lib/price-histories/repository'
import { getDistributorProduct } from '@/lib/distributor-products/repository'
import { authGuardError, apiError, toClientErrorMessage } from '@/lib/api-error'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const db = await createServerSupabase()
    try { await requireAuth(db) } catch (e) { return authGuardError(e) }
    const product = await getDistributorProduct(db, id)
    if (!product) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }

    const items = await getPriceHistory(db, id)
    return NextResponse.json({ items })
  } catch (err) {
    // WHY(2026-09-11): ここは `err.message` をそのまま 500 で返していた。
    //      DB の生エラー（制約名・列名・接続情報）がそのまま利用者へ出る形で、
    //      **2026-07-26 に `ClientVisibleError` を入れたときに拾われていなかった 1 件**。
    //      同じ日に作った走査（scripts/lib/scan-raw-error-response.mjs）が見つけた——
    //      手で数えたときは「変数へ移してから返す」形を見落としていた。
    return apiError(toClientErrorMessage(err, '価格履歴の取得に失敗しました'))
  }
}
