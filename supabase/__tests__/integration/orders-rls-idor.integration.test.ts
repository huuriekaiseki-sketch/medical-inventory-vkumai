// supabase/__tests__/integration/orders-rls-idor.integration.test.ts
// WHY: issue #20 発注履歴ページの受け入れ条件「自施設の発注のみが表示される（他施設の発注は
//      表示されない）」について、本物のローカルSupabaseへの接続を伴う統合テストが無いまま
//      実装が完了していた（4観点レビュー R1-R4 で仕様カバレッジ observed important指摘）。
//      listOrders() は facility_id を明示的に指定してクエリするが、その facilityId 自体が
//      信頼できる値か（呼び出し元のRLSが effectively 効いているか）は単体テスト（モックDB）
//      では検証できないため、real Supabase + RLS を経由して確認する。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { listOrders } from '@/lib/orders/repository'
import {
  cleanupOrdersRlsIdorFixtures,
  seedOrdersRlsIdorFixtures,
  type SeedOrdersRlsIdorFixtures,
} from './helpers/seed-rls-idor'

// 約束カタログ（docs/agents/promise-catalog.md）: P-010 他施設は読めない / P-014 横断履歴も施設境界
describe('orders（横断発注履歴） RLS/IDOR (issue #20) [P-010 P-014]', () => {
  let fixtures: SeedOrdersRlsIdorFixtures

  beforeAll(async () => {
    fixtures = await seedOrdersRlsIdorFixtures()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanupOrdersRlsIdorFixtures(fixtures)
    }
  })

  it('ユーザーBはlistOrdersで施設Aの発注を1件も取得できない', async () => {
    const orders = await listOrders(fixtures.userB.client, fixtures.facilityA.id, {}, 50, 0)
    expect(orders).toEqual([])
  })

  it('ユーザーAはlistOrdersで施設Aの4種別発注をすべて取得できる', async () => {
    const orders = await listOrders(fixtures.userA.client, fixtures.facilityA.id, {}, 50, 0)
    const ids = orders.map((o) => o.id)

    expect(ids).toContain(fixtures.caseOrderA.id)
    expect(ids).toContain(fixtures.consumableOrderA.id)
    expect(ids).toContain(fixtures.loanOrderA.id)
    expect(ids).toContain(fixtures.loanReturnA.id)
  })

  it('ユーザーBはkind指定（loan_order）でも施設Aの発注を取得できない', async () => {
    const orders = await listOrders(
      fixtures.userB.client,
      fixtures.facilityA.id,
      { kind: 'loan_order' },
      50,
      0
    )
    expect(orders).toEqual([])
  })
})
