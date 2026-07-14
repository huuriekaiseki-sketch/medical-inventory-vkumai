import { describe, it, expect } from 'vitest'
import { parsePagination, MAX_OFFSET } from '@/lib/api-pagination'

// WHY: limit/offset バリデーションが case-orders/consumable-orders/loan-orders/loan-returns/orders の
//      各 route.ts に同一ロジックとして重複実装されていた（レビュー指摘: 重複・過剰実装）。
//      共通ヘルパーへ切り出す際、既存の各 route.ts のバリデーション仕様（1〜200 / 0以上）を
//      壊していないことをここで担保する
describe('parsePagination', () => {
  it('limit/offset省略時はデフォルト値(50, 0)を返す', () => {
    const result = parsePagination(new URLSearchParams())
    expect(result).toEqual({ ok: true, limit: 50, offset: 0 })
  })

  it('limit/offsetが指定された場合はそのまま数値化して返す', () => {
    const result = parsePagination(new URLSearchParams('limit=10&offset=20'))
    expect(result).toEqual({ ok: true, limit: 10, offset: 20 })
  })

  it('limitが数値でない場合はok:falseかつ400のresponseを返す', () => {
    const result = parsePagination(new URLSearchParams('limit=abc'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })

  it('limitが0の場合はok:false（1未満は不可）', () => {
    const result = parsePagination(new URLSearchParams('limit=0'))
    expect(result.ok).toBe(false)
  })

  it('limitが上限(200)ちょうどの場合はok:true', () => {
    const result = parsePagination(new URLSearchParams('limit=200'))
    expect(result).toEqual({ ok: true, limit: 200, offset: 0 })
  })

  it('limitが上限を超える場合はok:false', () => {
    const result = parsePagination(new URLSearchParams('limit=201'))
    expect(result.ok).toBe(false)
  })

  it('offsetが負数の場合はok:false', () => {
    const result = parsePagination(new URLSearchParams('offset=-1'))
    expect(result.ok).toBe(false)
  })

  it('offsetが数値でない場合はok:false', () => {
    const result = parsePagination(new URLSearchParams('offset=xyz'))
    expect(result.ok).toBe(false)
  })

  // WHY: Number.isFinite(1.5) は true になるため、整数チェックを別途行わないと
  //      limit/offset に小数値が素通りしてしまう（issue #20 レビュー指摘: 型安全・正しさ）。
  //      DBのLIMIT/OFFSETは整数のみ有効なため、境界値として明示的に検証する
  it('limitが整数でない場合（小数）はok:false', () => {
    const result = parsePagination(new URLSearchParams('limit=1.5'))
    expect(result.ok).toBe(false)
  })

  it('offsetが整数でない場合（小数）はok:false', () => {
    const result = parsePagination(new URLSearchParams('offset=1.5'))
    expect(result.ok).toBe(false)
  })

  // WHY: offsetに上限が無いと、/api/orders の listOrders 内で
  //      effectiveLimit = max(KIND_LIMIT, offset+limit) が各テーブルへのクエリLIMITに
  //      直接使われるため、巨大なoffsetを指定するだけでDBに大量行取得を要求できてしまう
  //      （issue #20 レビュー指摘: 正しさ important, DoSベクタ）
  it('offsetが上限(MAX_OFFSET)ちょうどの場合はok:true', () => {
    const result = parsePagination(new URLSearchParams(`offset=${MAX_OFFSET}`))
    expect(result.ok).toBe(true)
  })

  it('offsetが上限(MAX_OFFSET)を超える場合はok:false（DoSベクタ防止）', () => {
    const result = parsePagination(new URLSearchParams(`offset=${MAX_OFFSET + 1}`))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.response.status).toBe(400)
  })
})
