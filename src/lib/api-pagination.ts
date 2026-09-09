import type { NextResponse } from 'next/server'
import { z } from 'zod'
import { apiError } from '@/lib/api-error'
import { firstIssueMessage } from '@/lib/validation/text-limits'

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
export const MIN_LIMIT = 1
export const MAX_LIMIT = 200

export const LIMIT_ERROR = `limit は ${MIN_LIMIT}〜${MAX_LIMIT} の整数で指定してください`
export const OFFSET_ERROR = `offset は 0〜${MAX_OFFSET} の整数で指定してください`

// WHY(2026-09-09、判定を 1 つにする): この関数と別に `/api/news` が独自の limit/offset 検証を
//      持っていて、**条件が食い違っていた**（あちらは Number.isFinite なので 1.5 が通り、
//      `< 0` なので 0 も通った）。E-053（同じ問いの答えが 2 か所にあって食い違う）そのもの。
//      判定をこのスキーマ 1 つにして、`parsePagination`（従来の呼び出し元）と
//      `parseQuery`（クエリ文字列の唯一の入口）の**両方がこれを使う**形にする。
//
// WHY(coerce を使う): クエリ文字列の値は必ず文字列。`z.coerce.number()` は空文字を 0 にするので、
//      未指定は `.optional()` で既定値へ倒し、**空文字は数値として不正**にしたい。
//      そのため文字列のまま受けて自前で数値へ写す（空文字は NaN になり int() で落ちる）。
const numeric = (fallback: number, message: string, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? fallback : Number(v)))
    .refine((n) => Number.isInteger(n) && n >= min && n <= max, { error: message })

/**
 * 一覧のページ送りのスキーマ。
 *
 * **判定（整数か・範囲に入るか）はここにしか無い。** 値（既定値と上下限）は route ごとに違ってよい。
 *
 * WHY(値だけを route ごとに変えられるようにする): E-053 で食い違っていたのは**判定**であって、
 *      値ではない。`/api/news` は上限 100・下限 0 を意図して選んでいた（テストで明示されている）。
 *      判定を 1 か所に寄せつつ、その意図は壊さない。
 */
export const paginationQueryShape = (
  options: { limit?: number; offset?: number; minLimit?: number; maxLimit?: number } = {}
) =>
  ({
    limit: numeric(
      options.limit ?? 50,
      `limit は ${options.minLimit ?? MIN_LIMIT}〜${options.maxLimit ?? MAX_LIMIT} の整数で指定してください`,
      options.minLimit ?? MIN_LIMIT,
      options.maxLimit ?? MAX_LIMIT
    ),
    offset: numeric(options.offset ?? 0, OFFSET_ERROR, 0, MAX_OFFSET),
  }) as const

/**
 * WHY(形（shape）も出す): ほかの項目と一緒に 1 つの `z.object` へ混ぜたい route がある
 *      （監査 route は kind・日付・絞り込みとページ送りを同時に受ける）。
 *      `.and()` で交差型にすると `superRefine` を掛けにくいので、**形を配って平らに合成**する。
 */
export const paginationQuerySchema = (
  options: { limit?: number; offset?: number; minLimit?: number; maxLimit?: number } = {}
) => z.object(paginationQueryShape(options))

export function parsePagination(
  params: URLSearchParams,
  defaults: { limit?: number; offset?: number } = {}
): PaginationResult {
  const parsed = paginationQuerySchema(defaults).safeParse({
    ...(params.get('limit') !== null ? { limit: params.get('limit')! } : {}),
    ...(params.get('offset') !== null ? { offset: params.get('offset')! } : {}),
  })
  if (!parsed.success) {
    return { ok: false, response: apiError(firstIssueMessage(parsed.error), 400) }
  }
  return { ok: true, limit: parsed.data.limit, offset: parsed.data.offset }
}
