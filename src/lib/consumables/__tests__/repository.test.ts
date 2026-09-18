import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listConsumablesByFacility,
  createConsumable,
  updateConsumable,
  retireConsumable,
  deleteConsumable,
  CONSUMABLE_NOT_FOUND_ERROR,
  CONSUMABLE_ALREADY_RETIRED_ERROR,
  CONSUMABLE_IN_USE_ERROR,
} from '@/lib/consumables/repository'
import { ClientVisibleError } from '@/lib/client-visible-error'

type Result = { data?: unknown; error?: unknown; count?: number | null }

/**
 * 表ごとに「呼ばれた順に返す結果」を並べた偽の DB。
 *
 * WHY(2026-09-09 に作り直した): 直す・止める・消すは **1 つの操作で表を 2 回以上引く**
 *      （施設のものか確かめる → 発注実績を数える → 消す）。
 *      入れ子のオブジェクトを手で組む書き方だと、条件を 1 つ足すたびに
 *      `query.eq is not a function` で落ちる（実際に落ちた）。
 *      呼び出しの形ではなく**結果の並び**で書けるようにする。
 */
function makeDb(queues: Record<string, Result[]>) {
  const calls: { table: string; result: Result }[] = []
  const from = vi.fn((table: string) => {
    const queue = queues[table]
    if (!queue || queue.length === 0) throw new Error(`偽 DB に ${table} の結果が用意されていない`)
    const result = queue.shift()!
    calls.push({ table, result })
    // どのメソッドを何回つないでも同じものを返し、await したときだけ結果になる
    const chain: Record<string, unknown> = {
      then: (resolve: (r: Result) => unknown) => Promise.resolve(result).then(resolve),
    }
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'order', 'single', 'maybeSingle']) {
      chain[m] = vi.fn(() => chain)
    }
    return chain
  })
  return { db: { from } as unknown as SupabaseClient, from, calls }
}

const mockRow = {
  id: 'c-1', facility_id: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
  created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z', status: 'active',
}

const mapped = {
  id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
  createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z', status: 'active', inUse: false,
}

describe('consumables repository', () => {
  it('listConsumablesByFacilityがConsumable[]を返す', async () => {
    const { db } = makeDb({ consumables: [{ data: [mockRow], error: null }] })
    const result = await listConsumablesByFacility(db, 'f-1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(mapped)
  })

  // WHY(2026-09-09): 発注で使われているかは、画面が「削除」と「使用停止」を出し分けるのに要る。
  //      埋め込みの件数が 0 と 1 以上で inUse が変わることを固定する
  it('発注実績の件数から inUse を作る', async () => {
    const { db } = makeDb({
      consumables: [{ data: [{ ...mockRow, consumable_order_items: [{ count: 3 }] }], error: null }],
    })
    const result = await listConsumablesByFacility(db, 'f-1')
    expect(result[0].inUse).toBe(true)
  })

  it('createConsumableがConsumableを返す', async () => {
    const { db } = makeDb({ consumables: [{ data: mockRow, error: null }] })
    const result = await createConsumable(db, 'f-1', { name: 'ガーゼ', jan: '4900000000001', purpose: '止血' })
    expect(result.id).toBe('c-1')
    expect(result.name).toBe('ガーゼ')
  })

  // WHY: consumables.jan は products(jan) への FK(20260714000004)。存在しないJANを指定した場合、
  //      生のPostgresエラー(23503・テーブル名やスキーマ情報を含みうる)をそのままthrowすると
  //      api-error.tsのtoClientErrorMessageがサニタイズし500になってしまう(issue #647 レビュー指摘)。
  //      ClientVisibleErrorとして翻訳し、route側で400として扱えるようにする。
  it('存在しないjanを指定した場合はClientVisibleErrorを投げる(FK違反)', async () => {
    const { db } = makeDb({
      consumables: [{
        data: null,
        error: { code: '23503', message: 'insert or update on table "consumables" violates foreign key constraint "consumables_jan_fkey"' },
      }],
    })
    await expect(
      createConsumable(db, 'f-1', { name: 'ガーゼ', jan: '9999999999999', purpose: '止血' })
    ).rejects.toBeInstanceOf(ClientVisibleError)
  })

  // WHY(2026-09-09・E-057): 直す・止める・消す道を足した。
  //      **RLS は拒否ではなく 0 行にする**ので、0 行を何に写すかを間違えると
  //      「他施設のものを操作しようとした」が 500 や成功に化ける
  describe('直す・止める・消す（E-057）', () => {
    it('updateConsumable: 施設のものが無ければ「見つかりません」', async () => {
      const { db } = makeDb({ consumables: [{ data: null, error: null }] })
      await expect(updateConsumable(db, 'f-1', 'c-1', { name: 'x', purpose: 'y' }))
        .rejects.toThrow(CONSUMABLE_NOT_FOUND_ERROR)
    })

    it('updateConsumable: 更新が 0 行なら「権限がありません」（読めるが書けない立場）', async () => {
      const { db } = makeDb({
        consumables: [{ data: mockRow, error: null }, { data: null, error: null }],
      })
      await expect(updateConsumable(db, 'f-1', 'c-1', { name: 'x', purpose: 'y' }))
        .rejects.toThrow('消耗品を直す権限がありません')
    })

    it('retireConsumable: すでに retired なら止め直せない', async () => {
      const { db } = makeDb({ consumables: [{ data: { ...mockRow, status: 'retired' }, error: null }] })
      await expect(retireConsumable(db, 'f-1', 'c-1')).rejects.toThrow(CONSUMABLE_ALREADY_RETIRED_ERROR)
    })

    it('retireConsumable: active なら retired にして返す', async () => {
      const { db } = makeDb({
        consumables: [{ data: mockRow, error: null }, { data: { ...mockRow, status: 'retired' }, error: null }],
      })
      const result = await retireConsumable(db, 'f-1', 'c-1')
      expect(result.status).toBe('retired')
    })

    // WHY(先に数える): 外部キー違反を待つと、拒まれた理由が「他の何か」かもしれない。
    //      数えてから消すことで 409 の意味を「使われている」に固定できる
    it('deleteConsumable: 発注で使われていれば消さずに理由を返す', async () => {
      const { db, calls } = makeDb({
        consumables: [{ data: mockRow, error: null }],
        consumable_order_items: [{ count: 2, error: null }],
      })
      await expect(deleteConsumable(db, 'f-1', 'c-1')).rejects.toThrow(CONSUMABLE_IN_USE_ERROR)
      // 消す側の問い合わせまで進んでいない（数えた時点で止まる）
      expect(calls.filter(c => c.table === 'consumables')).toHaveLength(1)
    })

    it('deleteConsumable: 使われていなければ消す', async () => {
      const { db } = makeDb({
        consumables: [{ data: mockRow, error: null }, { data: [{ id: 'c-1' }], error: null }],
        consumable_order_items: [{ count: 0, error: null }],
      })
      await expect(deleteConsumable(db, 'f-1', 'c-1')).resolves.toBeUndefined()
    })

    it('deleteConsumable: 削除が 0 行なら「権限がありません」（読めるが消せない立場）', async () => {
      const { db } = makeDb({
        consumables: [{ data: mockRow, error: null }, { data: [], error: null }],
        consumable_order_items: [{ count: 0, error: null }],
      })
      await expect(deleteConsumable(db, 'f-1', 'c-1')).rejects.toThrow('消耗品を消す権限がありません')
    })

    // WHY(競合): 数えたあとに他の人が発注する道は残る。そのときは DB が 23503 で拒むので、
    //      同じ 409 の意味に写す（利用者から見た結末を 1 つにする）
    it('deleteConsumable: 数えたあとに発注された（23503）も同じ理由に写す', async () => {
      const { db } = makeDb({
        consumables: [{ data: mockRow, error: null }, { data: null, error: { code: '23503', message: 'fk' } }],
        consumable_order_items: [{ count: 0, error: null }],
      })
      await expect(deleteConsumable(db, 'f-1', 'c-1')).rejects.toThrow(CONSUMABLE_IN_USE_ERROR)
    })
  })
})
