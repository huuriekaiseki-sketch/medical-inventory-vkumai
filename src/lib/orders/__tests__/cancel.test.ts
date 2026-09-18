import { describe, expect, it } from 'vitest'
import {
  cancelOrder,
  ORDER_ALREADY_CANCELLED_ERROR,
  ORDER_HAS_RETURNS_ERROR,
  ORDER_NOT_FOUND_ERROR,
} from '@/lib/orders/cancel'
import { ClientVisibleError } from '@/lib/client-visible-error'
import { INVARIANT_VIOLATION_MESSAGE } from '@/lib/invariant-error'

// WHY(2026-09-09): 取り消しの判定そのものは DB のトリガーが持っている（I-022）。
//      アプリ側の仕事は**エラーを利用者に読める一文へ写すこと**だけなので、
//      ここで固定するのは写し方。写しを間違えると
//      「返却を先に取り消してください」が「状態は戻せません」の汎用文になり、
//      利用者は何をすればよいか分からないまま詰まる。
//
//      DB のエラーの形（23514 ＋ `has active returns`）はここで作った偽物ではなく、
//      統合テスト（loan-order-cancel-boundary）が実 DB で同じ形を実測している。

type Row = { id: string; status: string }
type DbError = { code?: string; message: string } | null

/**
 * `db.from(table).select(...).eq(...).eq(...).maybeSingle()` と
 * `db.from(table).update(...).eq(...).eq(...).select(...).maybeSingle()` の
 * 両方に答える最小のスタブ。
 *
 * WHY(呼ばれた回数ではなく、呼ばれた操作で答える): 最初は「1 回目が読み取り・2 回目が更新」と
 *      **順番を数えて**いた。同じスタブで cancelOrder を 2 回呼ぶと 2 回目の読み取りが
 *      更新の結果を受け取り、**測りたい道と違う道**（見つからない）を通っていた（実際に踏んだ）。
 *      順番に依存する形は、テストの書き方しだいで黙って別の道へ落ちる。
 *      `update()` が呼ばれたかどうかで答えれば、**順番も再利用も関係なくなる**。
 *      `from()` ごとに新しい連鎖を作るので、1 つの db を何回使っても状態が混ざらない。
 */
function makeDb(options: {
  current: Row | null
  readError?: DbError
  updateError?: DbError
  updated?: Row | null
}) {
  return {
    from: () => {
      let isUpdate = false
      const chain = {
        select: () => chain,
        update: () => {
          isUpdate = true
          return chain
        },
        eq: () => chain,
        maybeSingle: async () =>
          isUpdate
            ? { data: options.updated ?? null, error: options.updateError ?? null }
            : { data: options.current, error: options.readError ?? null },
      }
      return chain
    },
  } as never
}

const FACILITY = '11111111-1111-1111-1111-111111111111'
const ORDER = '22222222-2222-2222-2222-222222222222'

describe('cancelOrder のエラーの写し方 [I-022]', () => {
  it('返却が残っている（23514 ＋ has active returns）を、やることが分かる一文に写す', async () => {
    const db = makeDb({
      current: { id: ORDER, status: 'submitted' },
      updateError: {
        code: '23514',
        message: `loan order ${ORDER} has active returns; cancel the returns first`,
      },
    })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toThrow(ORDER_HAS_RETURNS_ERROR)
  })

  it('同じ 23514 でも、別の業務ルール違反は汎用の一文のまま（写しすぎない）', async () => {
    // WHY(C-023 の型): 合図（23514）が同じなので、文言まで見ないと層を取り違える。
    //      何でも「返却を取り消してください」に写すと、まったく別の原因を誤って案内する
    const db = makeDb({
      current: { id: ORDER, status: 'submitted' },
      updateError: { code: '23514', message: 'status cannot go back from submitted to draft' },
    })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toThrow(INVARIANT_VIOLATION_MESSAGE)
  })

  it('文言が同じでもコードが違えば写さない（23514 であることも見る）', async () => {
    const db = makeDb({
      current: { id: ORDER, status: 'submitted' },
      updateError: { code: '23503', message: 'has active returns' },
    })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.not.toThrow(ORDER_HAS_RETURNS_ERROR)
  })

  it('見つからない発注は 404 用のエラー', async () => {
    const db = makeDb({ current: null })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toThrow(ORDER_NOT_FOUND_ERROR)
  })

  it('すでに取り消し済みなら 409 用のエラー', async () => {
    const db = makeDb({ current: { id: ORDER, status: 'cancelled' } })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toThrow(ORDER_ALREADY_CANCELLED_ERROR)
  })

  it('通る道: 取り消せたら cancelled を返す（対照）', async () => {
    const db = makeDb({
      current: { id: ORDER, status: 'submitted' },
      updated: { id: ORDER, status: 'cancelled' },
    })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).resolves.toEqual({
      id: ORDER,
      status: 'cancelled',
    })
  })

  it('書けなかった（RLS で 0 行）は権限のエラーで、取り消し済みとは別の文言', async () => {
    // 同じ db を 2 回使う（スタブが順番に依存していないことの対照でもある）
    const db = makeDb({ current: { id: ORDER, status: 'submitted' }, updated: null })
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toBeInstanceOf(ClientVisibleError)
    await expect(cancelOrder(db, 'loan_orders', FACILITY, ORDER)).rejects.toThrow(
      '発注を取り消す権限がありません'
    )
  })
})
