import type { NextResponse } from 'next/server'
import { apiError } from '@/lib/api-error'

// WHY: limit/offset バリデーションが case-orders/consumable-orders/loan-orders/loan-returns/orders の
//      各 route.ts に完全に同一のロジックとして重複実装されていた（issue #20 レビュー指摘:
//      重複・過剰実装）。仕様変更（上限値変更など）が発生した際に1箇所の修正で全routeへ
//      反映できるよう、共通ヘルパーへ切り出す
export type PaginationResult =
  | { ok: true; limit: number; offset: number }
  | { ok: false; response: NextResponse<{ error: string }> }

// WHY: offsetに上限が無いと、/api/orders の listOrders は
//      `effectiveLimit = Math.max(KIND_LIMIT, offset + limit)` を各テーブルのクエリLIMITに
//      直接使うため、非常に大きなoffsetを渡すだけで各テーブルへ数百万行規模のLIMITを
//      要求できてしまい、DoSベクタになる（issue #20 レビュー指摘: 正しさ important）。
//      offsetにも他パラメータ同様、常識的な上限を設ける
export const MAX_OFFSET = 100_000

export function parsePagination(
  params: URLSearchParams,
  defaults: { limit?: number; offset?: number } = {}
): PaginationResult {
  const limit = Number(params.get('limit') ?? String(defaults.limit ?? 50))
  const offset = Number(params.get('offset') ?? String(defaults.offset ?? 0))

  // WHY: Number.isFinite(1.5) は true になるため、これだけでは小数値を弾けない。
  //      DBのLIMIT/OFFSETは整数のみ有効なため、Number.isInteger で整数であることも検証する
  //      （issue #20 レビュー指摘: 正しさ・型安全 minor）
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return { ok: false, response: apiError('limit は 1〜200 の整数で指定してください', 400) }
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
    return { ok: false, response: apiError(`offset は 0〜${MAX_OFFSET} の整数で指定してください`, 400) }
  }
  return { ok: true, limit, offset }
}
