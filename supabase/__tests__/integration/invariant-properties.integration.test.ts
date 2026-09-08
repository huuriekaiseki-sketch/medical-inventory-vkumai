// supabase/__tests__/integration/invariant-properties.integration.test.ts
// WHY: issue #757 の 6（プロパティテスト）。不変条件カタログ（docs/agents/invariant-catalog.md）の
//      既存テストは**代表値 1〜2 点**（quantity 0、unit_price -1、201 文字）しか通していない。
//      それは「その 1 点で止まる」ことしか言っておらず、**境界そのもの**は測っていない。
//
//      ここで測るのは「DB が受け入れる ⟺ カタログの条件を満たす」という同値関係。
//      値は乱数で作る。私が「危なそう」と思った値を並べると、生成元がテストと同じになり
//      （取りこぼし台帳の独立性の表でいう「同源」）、思いつかなかった形は永久に出てこない。
//
//      落ちたときは fast-check が最小の反例まで縮めてくれる（例:「quantity=2147483648 で落ちる」）。
//
// 既知の限界:
//   - **実 DB を叩くので回数を絞っている**（numRuns は下の RUNS）。網羅ではなく抜き取り。
//     seed を固定していないので、走るたびに違う値を試す（＝再現には出力の seed が要る）。
//   - ここが見るのは「DB が受け入れるか」だけで、**その条件が業務として正しいか**は何も言わない。
//     値の妥当性は docs/agents/design-questions.md（作る前に人に聞く）側の担当。
//   - 画面・API 層の検証は対象外。DB より手前で弾いていても、ここは DB に直接届く経路で測る。

import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupHospitalPricesRlsIdorFixtures,
  createServiceRoleClient,
  seedHospitalPricesRlsIdorFixtures,
  type SeedHospitalPricesRlsIdorFixtures,
} from './helpers/seed-rls-idor'

const CHECK_VIOLATION = '23514'
/** PostgreSQL の INTEGER の範囲。これを超えると 23514 ではなく 22003 になる */
const INT4_MAX = 2147483647

// WHY(回数): 1 回ごとに DB 往復が入る。25 回 × 4 性質 ≒ 100 往復で、実測 10 秒台に収まる。
//      増やすほど網羅に近づくが、統合テスト全体の所要時間と引き換えになる。
const RUNS = 25

// 不変条件カタログ: I-010（数量は 1 以上）/ I-012（単価は 0 以上）/ I-020（状態は前にしか進まない）
describe('不変条件は代表値ではなく境界で成り立つ（プロパティ） [I-010 I-012 I-020]', () => {
  const serviceClient = createServiceRoleClient()
  let fx: SeedHospitalPricesRlsIdorFixtures
  let orderId: string

  beforeAll(async () => {
    fx = await seedHospitalPricesRlsIdorFixtures()
    // 明細をぶら下げるための短貸発注を 1 件だけ作る（各試行で使い回す）
    const { data, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
      p_facility_id: fx.facilityA.id,
      p_procedure_name: 'プロパティテスト',
      p_maker: 'テストメーカー',
      p_items: [],
    })
    if (error || !data) throw new Error(`発注作成失敗: ${error?.message}`)
    orderId = (data as { id: string }).id
  }, 60_000)

  afterAll(async () => {
    if (fx) await cleanupHospitalPricesRlsIdorFixtures(fx)
  })

  // ---------------------------------------------------------------------------
  // I-010 数量
  // ---------------------------------------------------------------------------

  it('I-010 INTEGER の範囲内なら「通る ⟺ quantity >= 1」', async () => {
    // WHY(空振り検知): プロパティは**両方の枝に届いて初めて**意味を持つ。生成が偏って
    //      片側しか通らなくてもテストは緑になるので、それは「テストはあるが何も見ていない」状態。
    //      到達を数えて、両側に届いたことまで固定する。
    const hits = { accepted: 0, rejected: 0 }
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: -INT4_MAX - 1, max: INT4_MAX }), async (quantity) => {
        const { data, error } = await serviceClient
          .from('loan_order_items')
          .insert({ loan_order_id: orderId, name: '数量プロパティ', quantity })
          .select('id')
          .maybeSingle()

        if (quantity >= 1) {
          // 通るべき側。通ったなら後始末をして次へ
          expect(error).toBeNull()
          hits.accepted += 1
          if (data) await serviceClient.from('loan_order_items').delete().eq('id', data.id)
        } else {
          // 止まるべき側。**なぜ止まったか**まで見る（23514 でなければアプリの文言写像が効かない）
          expect(error?.code).toBe(CHECK_VIOLATION)
          hits.rejected += 1
        }
      }),
      { numRuns: RUNS },
    )
    expect(hits.accepted).toBeGreaterThan(0)
    expect(hits.rejected).toBeGreaterThan(0)
  }, 120_000)

  it('I-010 INTEGER の範囲を超えた数量は 23514 では止まらない（写像の穴を明示する）', async () => {
    // WHY: これは「直すべき欠陥」ではなく**書いておくべき限界**。quantity は INTEGER なので、
    //      2147483648 は CHECK に到達する前に型変換で落ちる。返るのは 22003 系であって 23514 ではない。
    //      src/lib/invariant-error.ts は 23514 だけを利用者向けの一文に写像しているので、
    //      この経路は「予期しないエラー」になる。**どこからが写像の外か**をテストで固定しておく。
    // WHY(bigint リテラルを使わない): tsconfig の target が ES2020 未満なので `1n` が書けない。
    //      倍率を生成して掛けるだけで、INT4_MAX を超えた値は作れる。
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 1000 }), fc.integer({ min: 1, max: 1000 }), async (mult, offset) => {
        const huge = INT4_MAX * mult + offset
        const { error } = await serviceClient
          .from('loan_order_items')
          .insert({ loan_order_id: orderId, name: '範囲外', quantity: huge })
        expect(error).not.toBeNull()
        expect(error?.code).not.toBe(CHECK_VIOLATION)
      }),
      { numRuns: 5 },
    )
  }, 60_000)

  // ---------------------------------------------------------------------------
  // I-012 単価
  // ---------------------------------------------------------------------------

  // WHY(最初に書いたプロパティは間違っていた): 「通る ⟺ 送った unit_price >= 0」と書いたところ、
  //      1 回目の実行で反例 `-5e-324`（負の最小非正規化数）が出た。DB は受け入れていた。
  //      原因は列が NUMERIC(12,2) であることで、scale より小さい負の値は 0.00 に丸めて格納される。
  //      **DB が正しく、プロパティの書き方が間違っていた。** 不変条件は「送った値」ではなく
  //      「**格納された値**」についての条件（カタログの I-012 も「単価スナップショットは 0 以上」）。
  //      この取り違えは代表値テスト（-1 を送って 23514）では永久に出てこない。
  it('I-012 通ったなら格納された単価は必ず 0 以上（NUMERIC の丸めを含む）', async () => {
    // WHY(枝ごとに生成器を分ける): 最初は `fc.double({ min: -1e6, max: 1e6 })` の 1 本にしていたが、
    //      2026-09-07 の実行で **25 回とも「はっきり負の値」が出ず**、空振り検知（hits.rejected > 0）
    //      が落ちた。fast-check は端の値（0・非正規化数）へ寄せるので、範囲だけ与えても
    //      両方の枝に届く保証が無い。**揺れるテストになった**（property-testing.md の限界そのもの）。
    //      値は乱数のまま、枝への到達だけを構造で保証する。
    const hits = { accepted: 0, rejected: 0 }
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant(null),
          // 通る側（0 以上、および scale で 0.00 に丸まる微小な負）
          fc.double({ min: 0, max: 1e6, noNaN: true, noDefaultInfinity: true }),
          fc.double({ min: -0.004, max: 0, noNaN: true, noDefaultInfinity: true }),
          // 止まる側（丸めても負のまま）
          fc.double({ min: -1e6, max: -0.01, noNaN: true, noDefaultInfinity: true }),
        ),
        async (unitPrice) => {
          const { data, error } = await serviceClient
            .from('loan_order_items')
            .insert({ loan_order_id: orderId, name: '単価プロパティ', quantity: 1, unit_price: unitPrice })
            .select('id, unit_price')
            .maybeSingle()

          if (error) {
            // 止まったなら 23514 でなければならない（そうでないと利用者向けの文言に写像されない）
            expect(error.code).toBe(CHECK_VIOLATION)
            hits.rejected += 1
            return
          }
          // 通ったなら、**読み戻した値**が不変条件を満たしていること
          expect(data).not.toBeNull()
          const stored = data!.unit_price as number | null
          if (stored !== null) expect(Number(stored)).toBeGreaterThanOrEqual(0)
          hits.accepted += 1
          await serviceClient.from('loan_order_items').delete().eq('id', data!.id)
        },
      ),
      { numRuns: RUNS },
    )
    expect(hits.accepted).toBeGreaterThan(0)
    expect(hits.rejected).toBeGreaterThan(0)
  }, 120_000)

  it('I-012 小数第 2 位まででも負と分かる値は 23514 で止まる', async () => {
    // WHY: 上のプロパティは「格納後が 0 以上」しか言っておらず、それだけだと
    //      「負の値を全部 0 に丸めて受け入れる」実装でも通ってしまう。
    //      **丸めても負のままの大きさ**（0.01 以上）は必ず拒否されることを別に固定する。
    await fc.assert(
      fc.asyncProperty(fc.double({ min: -1e6, max: -0.01, noNaN: true, noDefaultInfinity: true }), async (negative) => {
        const { error } = await serviceClient
          .from('loan_order_items')
          .insert({ loan_order_id: orderId, name: '負の単価', quantity: 1, unit_price: negative })
        expect(error?.code).toBe(CHECK_VIOLATION)
      }),
      { numRuns: RUNS },
    )
  }, 120_000)

  // ---------------------------------------------------------------------------
  // I-020 状態遷移
  // ---------------------------------------------------------------------------

  it('I-020 どんな順番で status を更新しても draft から出たら戻れない', async () => {
    // WHY(ここが一番プロパティ向き): 状態遷移は「順番の組み合わせ」なので、手で並べた 1 本の
    //      シナリオでは穴が残る。draft→submitted→draft は既存テストにあるが、
    //      submitted→submitted→draft のような**同じ値を挟む列**は誰も試していなかった。
    const statuses = ['draft', 'submitted'] as const
    // 「戻そうとして拒否された」回数。0 のままなら、この性質は一度も試されていない
    const hits = { blockedRollback: 0, forwardMoves: 0 }

    // WHY(出発点を 2 つ試す・2026-09-08): 発注は 2 通りの生まれ方がある。
    //      画面の経路（RPC）は **submitted** で作り（E-052 の修正、20260908020000）、
    //      列の既定値は **draft** のまま残してある。出発点を決め打ちにすると、
    //      作られ方が変わったときに黙って片方しか試さなくなる。
    //      作った直後の実際の status を読んでから列を適用する。
    const createSubmitted = async () => {
      const { data, error } = await fx.userA.client.rpc('create_loan_order_atomic', {
        p_facility_id: fx.facilityA.id,
        p_procedure_name: '状態遷移プロパティ',
        p_maker: 'テストメーカー',
        p_items: [],
      })
      expect(error).toBeNull()
      return data as { id: string; status: 'draft' | 'submitted' }
    }
    const createDraft = async () => {
      const { data, error } = await serviceClient
        .from('loan_orders')
        .insert({ facility_id: fx.facilityA.id, procedure_name: '状態遷移プロパティ（既定値）', maker: 'テストメーカー' })
        .select('id, status')
        .single()
      expect(error).toBeNull()
      return data as { id: string; status: 'draft' | 'submitted' }
    }

    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...statuses), { minLength: 1, maxLength: 4 }), async (sequence) => {
        for (const create of [createSubmitted, createDraft]) {
          const row = await create()
          try {
            // 一度でも submitted になったら draft には戻れない
            let expected = row.status
            for (const next of sequence) {
              const { error } = await serviceClient.from('loan_orders').update({ status: next }).eq('id', row.id)
              const allowed = !(expected === 'submitted' && next === 'draft')
              if (allowed) {
                expect(error).toBeNull()
                if (expected !== next) hits.forwardMoves += 1
                expected = next
              } else {
                expect(error?.code).toBe(CHECK_VIOLATION)
                hits.blockedRollback += 1
              }
            }
            const { data: final } = await serviceClient.from('loan_orders').select('status').eq('id', row.id).single()
            expect(final!.status).toBe(expected)
          } finally {
            await serviceClient.from('loan_orders').delete().eq('id', row.id)
          }
        }
      }),
      { numRuns: RUNS },
    )
    // 前へ進む列も、戻そうとして弾かれる列も、両方試したこと
    expect(hits.forwardMoves).toBeGreaterThan(0)
    expect(hits.blockedRollback).toBeGreaterThan(0)
  }, 180_000)
})
