// supabase/__tests__/integration/loan-returns-rls-idor.integration.test.ts
// WHY: 施設A/施設Bという2つの本物のテスト施設と、それぞれに所属する本物の
//      認証済みユーザーを使い、「施設Bのユーザーが施設Aの返却(loan_returns)に
//      アクセスできない」ことをPostgREST/RPC越しに直接確認する。
//      loan_returnsはloan_ordersと同じfacility_member_or_admin RLSポリシー
//      （supabase/migrations/20260628010001_update_rls_admin.sql）で保護されて
//      おり、src/lib/dashboard/loan-outstanding.tsのgetLoanOutstandingCountが
//      このテーブルをクエリしているが、case_orders/consumable_orders/loan_orders
//      にはあるテーブル単体のRLS/IDOR統合テストがloan_returnsだけ欠落していた
//      （docs/agents/known-failure-patterns.md「RLS/テナント分離層」チェックリスト）。
//      モック・静的SQL検証ではなく、本物のローカルSupabaseへの接続を伴う。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupLoanReturnsRlsIdorFixtures,
  seedLoanReturnsRlsIdorFixtures,
  type SeedLoanReturnsRlsIdorFixtures,
  createServiceRoleClient,
} from './helpers/seed-rls-idor'
import { describeDenial, isPermissionDenied } from './helpers/pg-error'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-012 RPC に他施設 id は forbidden / P-015 自施設は通る（対照）/ P-050 返却は 1 件まで
// 不変条件カタログ（docs/agents/invariant-catalog.md）: I-030 短貸発注 1 件に返却は 1 件まで
describe('loan_returns RLS/IDOR [P-010 P-012 P-015 I-030]', () => {
  let fixtures: SeedLoanReturnsRlsIdorFixtures
  /**
   * 内側の describe が作る製品。**外側で消す。**
   *
   * WHY(内側の afterAll で消さない、2026-09-10): `loan_return_items.jan` は
   *      `products.jan` への FK。内側の afterAll は親より先に走るので、
   *      そのとき返却明細はまだ生きていて 23503 で消せない。
   *      施設が消えて明細が連鎖で消えたあと（＝外側）に消す。
   */
  let partialReturnJan: string | undefined

  beforeAll(async () => {
    fixtures = await seedLoanReturnsRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupLoanReturnsRlsIdorFixtures(fixtures)
    }
    if (partialReturnJan) {
      const { error } = await createServiceRoleClient()
        .from('products')
        .delete()
        .eq('jan', partialReturnJan)
      if (error) throw new Error(`[loan-returns] 分割返却用の製品を消せませんでした: ${error.message}`)
    }
  })

  it('ユーザーBは施設Aのloan_returnsを1件も取得できない', async () => {
    const { data, error } = await fixtures.userB.client
      .from('loan_returns')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('ユーザーBは施設Aに対してcreate_loan_return_atomicを呼ぶと拒否される', async () => {
    const { data, error } = await fixtures.userB.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fixtures.facilityA.id,
        return_datetime: new Date().toISOString(),
      },
      p_items: [],
    })

    expect(data).toBeNull()
    expect(error).not.toBeNull()
  })

  it('ユーザーAは自分の施設Aのloan_returnsを取得でき、シード済みの1件が含まれる', async () => {
    const { data, error } = await fixtures.userA.client
      .from('loan_returns')
      .select('*')
      .eq('facility_id', fixtures.facilityA.id)

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.length).toBeGreaterThanOrEqual(1)
    expect(data!.some((row) => row.id === fixtures.loanReturnA.id)).toBe(true)
  })

  it('ユーザーAは自分の施設Aに対してcreate_loan_return_atomicを呼ぶと成功する', async () => {
    const { data, error } = await fixtures.userA.client.rpc('create_loan_return_atomic', {
      p_header: {
        facility_id: fixtures.facilityA.id,
        return_datetime: new Date().toISOString(),
      },
      p_items: [],
    })

    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect((data as { facility_id?: string })?.facility_id).toBe(fixtures.facilityA.id)
  })

  // WHY(2026-09-08 → 09 で約束が変わった): 以前ここは「**DB は施設の writer に DELETE を許すが、
  //      アプリに経路が無い**」を実測して固定していた（E-056 の発端）。
  //      2026-09-09、その食い違いを機械で数えたところ同じ形が 8 表に残っていたので、
  //      **使っていない DELETE 権限を剥がした**（20260909020000。人の判断）。
  //
  //      いま守るのは「**誰も消せない**」。間違えた返却は削除ではなく `cancelled` にする。
  //
  //      WHY(0 行ではなく 42501 になったことを見る): 権限を剥がす前は、他施設の利用者も
  //      RLS で 0 行になるだけで**エラーにならなかった**（「見つかりません」と区別できない）。
  //      いまは権限そのものが無いので、**拒否がはっきり返る**。この違いが剥がした効き目そのもの。
  describe('返却は誰も消せない: DELETE の権限を剥がした（E-056 / E-057 の型）', () => {
    /** 施設 A の返却を 1 件作って id を返す。後片付けは service_role で行う */
    async function seedReturn(serviceClient: ReturnType<typeof createServiceRoleClient>) {
      const { data: created, error: createError } = await serviceClient
        .from('loan_returns')
        .insert({
          facility_id: fixtures.facilityA.id,
          return_datetime: new Date().toISOString(),
        })
        .select('id')
        .single()
      expect(createError).toBeNull()
      return created!.id as string
    }

    it('ユーザーBは施設Aの返却を消せない（42501。行も残っている）', async () => {
      const serviceClient = createServiceRoleClient()
      const id = await seedReturn(serviceClient)

      const { error } = await fixtures.userB.client.from('loan_returns').delete().eq('id', id).select('id')
      expect(isPermissionDenied(error), `他施設の利用者に DELETE が通った: ${describeDenial(error)}`).toBe(true)

      const { data: still } = await serviceClient.from('loan_returns').select('id').eq('id', id)
      expect(still, '他施設の利用者が返却を消せてしまった').toHaveLength(1)

      await serviceClient.from('loan_returns').delete().eq('id', id)
    })

    it('ユーザーAも自施設の返却を消せない（42501。writer でも消せない）', async () => {
      const serviceClient = createServiceRoleClient()
      const id = await seedReturn(serviceClient)

      const { error } = await fixtures.userA.client.from('loan_returns').delete().eq('id', id).select('id')
      expect(isPermissionDenied(error), `自施設の writer に DELETE が通った（剥がした権限が戻っている）: ${describeDenial(error)}`).toBe(true)

      const { data: still } = await serviceClient.from('loan_returns').select('id').eq('id', id)
      expect(still, '自施設の writer が返却を消せてしまった').toHaveLength(1)

      await serviceClient.from('loan_returns').delete().eq('id', id)
    })

    // WHY(対照): 消せないことだけを測ると、「何も通らない」実装でも緑になる（C-021）。
    //      同じ利用者が**取り消し（UPDATE）はできる**ことを対で測り、
    //      剥がしたのが DELETE だけであることを固定する
    it('同じユーザーAが取り消し（status の更新）はできる（対照）', async () => {
      const serviceClient = createServiceRoleClient()
      const id = await seedReturn(serviceClient)

      const { data: updated, error } = await fixtures.userA.client
        .from('loan_returns')
        .update({ status: 'cancelled' })
        .eq('id', id)
        .select('id, status')
      expect(error, '取り消しまで通らなくなっている（UPDATE も剥がれた？）').toBeNull()
      expect(updated ?? []).toHaveLength(1)

      await serviceClient.from('loan_returns').delete().eq('id', id)
    })
  })

  // WHY(2026-09-08 に約束が変わった): 20260828000001 の部分 UNIQUE は
  //  「1 発注 : 1 返却」を強制していたが、**分割して返す運用が実在する**ことを確認したので
  //  20260908030000 で外した。守るものは「2 回目を拒否する」から
  //  **「明細ごとに、借りた数を超えて返せない」**に変わった（P-050）。
  //  静的 SQL 検証ではなく本物のローカル Supabase への RPC 呼び出しで確認する。
  describe('借りた数を超えて返せない（分割返却）[P-050]', () => {
    // WHY: `loan_return_items.jan` は `products.jan` への外部キー（E-050）。
    //      作り話の JAN では 23503 で弾かれるので、この describe 用に 1 件作っておく
    let jan: string

    beforeAll(async () => {
      const serviceClient = createServiceRoleClient()
      const suffix = Math.random().toString(36).slice(2, 10)
      jan = `partial-return-jan-${suffix}`
      const { error } = await serviceClient
        .from('products')
        .insert({ jan, ref: `partial-return-ref-${suffix}` })
      if (error) throw new Error(`[loan-returns partial test] products シード失敗: ${error.message}`)
      // 後片付けは外側の afterAll がやる（明細が消えてからでないと FK で消せない）
      partialReturnJan = jan
    })

    async function createLoanOrderForFacilityA(quantity: number): Promise<{ orderId: string; itemId: string }> {
      const { data, error } = await fixtures.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fixtures.facilityA.id,
        p_procedure_name: '分割返却テスト術式',
        p_maker: '分割返却テストメーカー',
        p_items: [{ name: '分割返却テスト器材', quantity }],
      })
      if (error || !data) {
        throw new Error(`[loan-returns partial test] loan_orders シード作成失敗: ${error?.message}`)
      }
      const order = data as { id: string; items: { id: string }[] }
      return { orderId: order.id, itemId: order.items[0].id }
    }

    const makeReturn = (orderId: string, itemId: string, quantity: number) =>
      fixtures.userA.client.rpc('create_loan_return_atomic', {
        p_header: {
          facility_id: fixtures.facilityA.id,
          return_datetime: new Date().toISOString(),
          loan_order_id: orderId,
        },
        p_items: [{ jan, quantity, loan_order_item_id: itemId }],
      })

    it('同じ短貸発注へ 2 回目の返却ができる（分割して返せる）', async () => {
      const { orderId, itemId } = await createLoanOrderForFacilityA(2)

      const first = await makeReturn(orderId, itemId, 1)
      expect(first.error, JSON.stringify(first.error)).toBeNull()

      // WHY: 部分 UNIQUE があったころは、ここが 23505 で弾かれていた
      const second = await makeReturn(orderId, itemId, 1)
      expect(second.error, JSON.stringify(second.error)).toBeNull()

      const { data: rows } = await fixtures.userA.client
        .from('loan_returns')
        .select('id')
        .eq('loan_order_id', orderId)
      expect(rows?.length, '同じ発注に 2 件の返却が残る').toBe(2)
    })

    it('合計が借りた数を超える返却は拒否される', async () => {
      const { orderId, itemId } = await createLoanOrderForFacilityA(2)
      expect((await makeReturn(orderId, itemId, 2)).error).toBeNull()

      const over = await makeReturn(orderId, itemId, 1)
      expect(over.error?.code, JSON.stringify(over.error)).toBe('23514')
    })

    it('全部返す返却を 2 件同時に送ると、成功 1 件・失敗 1 件になる', async () => {
      // WHY: 2 件が同時に「まだ余っている」と読んで両方通ると、借りた数の 2 倍が返る。
      //      トリガーが発注明細を FOR UPDATE で掴んで順番を付けていることを実測する
      const { orderId, itemId } = await createLoanOrderForFacilityA(1)

      const results = await Promise.all([
        makeReturn(orderId, itemId, 1),
        makeReturn(orderId, itemId, 1),
      ])
      const succeeded = results.filter((r) => r.error === null)
      const failed = results.filter((r) => r.error !== null)
      expect(succeeded.length, JSON.stringify(results.map((r) => r.error))).toBe(1)
      expect(failed.length).toBe(1)
      expect(failed[0].error?.code).toBe('23514')

      const { data: items } = await fixtures.userA.client
        .from('loan_return_items')
        .select('quantity')
        .eq('loan_order_item_id', itemId)
      const total = (items ?? []).reduce((n, i) => n + (i.quantity as number), 0)
      expect(total, '借りた数を超えて記録が残った').toBe(1)
    })

    // WHY(E-056): 間違えて登録した返却を直せるようにした（20260908060000）。
    //      **行は消さず `cancelled` にする**ので、取り消した返却は
    //      「残数」「未返却の件数」のどちらからも除かれなければならない。
    //      除かれていないと、取り消しても返し直せない（残数が戻らない）。
    describe('返却の取り消し [I-030 I-021]', () => {
      it('取り消すと残数が戻り、同じ数だけ返し直せる', async () => {
        const { orderId, itemId } = await createLoanOrderForFacilityA(2)

        const first = await makeReturn(orderId, itemId, 2)
        expect(first.error, JSON.stringify(first.error)).toBeNull()
        const returnId = (first.data as { id: string }).id

        // 全部返したので、もう 1 本も返せない
        const before = await makeReturn(orderId, itemId, 1)
        expect(before.error?.code, '全部返したのに、まだ返せてしまう').toBe('23514')

        // 取り消す
        const { data: cancelled, error: cancelError } = await fixtures.userA.client
          .from('loan_returns')
          .update({ status: 'cancelled' })
          .eq('id', returnId)
          .select('id, status')
          .single()
        expect(cancelError, JSON.stringify(cancelError)).toBeNull()
        expect(cancelled!.status).toBe('cancelled')

        // 残数が戻り、返し直せる
        const after = await makeReturn(orderId, itemId, 2)
        expect(after.error, '取り消したのに残数が戻っていない').toBeNull()
      })

      // WHY(基準ではなく前後差で見る): この施設には他のテストが作った発注も残っている。
      //      固定の基準と比べると、テストの実行順で結果が変わる（最初にそれで落ちた）。
      //      **自分の操作の前後の差**だけを見れば、他の行が何件あっても成り立つ。
      it('取り消した返却は未返却の件数に数えない（数えると発注が返却済みに見える）', async () => {
        const outstanding = async () => {
          const { data } = await fixtures.userA.client.rpc('loan_outstanding_count', {
            p_facility_id: fixtures.facilityA.id,
          })
          return data as number
        }

        const { orderId, itemId } = await createLoanOrderForFacilityA(1)
        const withOrder = await outstanding()

        const created = await makeReturn(orderId, itemId, 1)
        expect(created.error, JSON.stringify(created.error)).toBeNull()
        const returnId = (created.data as { id: string }).id

        const afterReturn = await outstanding()
        expect(afterReturn, '全部返したのに未返却が減らない').toBe(withOrder - 1)

        await fixtures.userA.client
          .from('loan_returns')
          .update({ status: 'cancelled' })
          .eq('id', returnId)

        const afterCancel = await outstanding()
        expect(
          afterCancel,
          '取り消したのに未返却へ戻らない（取り消した返却をまだ数えている）'
        ).toBe(withOrder)
      })

      it('取り消しからは戻れない（終端）', async () => {
        const { orderId, itemId } = await createLoanOrderForFacilityA(1)
        const created = await makeReturn(orderId, itemId, 1)
        const returnId = (created.data as { id: string }).id

        await fixtures.userA.client
          .from('loan_returns')
          .update({ status: 'cancelled' })
          .eq('id', returnId)

        const { error } = await fixtures.userA.client
          .from('loan_returns')
          .update({ status: 'returned' })
          .eq('id', returnId)
        expect(error?.code, '取り消しから戻せてしまう').toBe('23514')
      })

      it('決めていない状態にはできない（語彙は draft / returned / cancelled だけ）', async () => {
        const { orderId, itemId } = await createLoanOrderForFacilityA(1)
        const created = await makeReturn(orderId, itemId, 1)
        const returnId = (created.data as { id: string }).id

        const { error } = await fixtures.userA.client
          .from('loan_returns')
          .update({ status: 'voided' })
          .eq('id', returnId)
        expect(error?.code, '知らない状態が通ってしまう').toBe('23514')
      })

      it('他施設の利用者は取り消せない', async () => {
        const { orderId, itemId } = await createLoanOrderForFacilityA(1)
        const created = await makeReturn(orderId, itemId, 1)
        const returnId = (created.data as { id: string }).id

        const { data, error } = await fixtures.userB.client
          .from('loan_returns')
          .update({ status: 'cancelled' })
          .eq('id', returnId)
          .select('id')
        expect(error).toBeNull()
        expect(data ?? [], '他施設の返却を取り消せてしまった').toEqual([])

        const serviceClient = createServiceRoleClient()
        const { data: still } = await serviceClient
          .from('loan_returns')
          .select('status')
          .eq('id', returnId)
          .single()
        expect(still!.status).toBe('returned')
      })
    })
  })
})
