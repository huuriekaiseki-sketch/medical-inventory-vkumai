import type { NextRequest } from 'next/server'
import type { RouteContext } from '@/types/route'
import { handleOrderCancel } from '@/lib/orders/cancel-route'

/** 短貸発注の取り消し（E-056）。認可とエラーの写し分けは 3 種で共有する */
export async function PATCH(request: NextRequest, context: RouteContext) {
  return handleOrderCancel(request, context.params, 'loan_orders')
}
