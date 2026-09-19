// supabase/__tests__/integration/lot-search-rls-idor.integration.test.ts
// WHY(issue #803 SPEC Part 2「守りは3層」): ロット検索の repository（src/lib/lot-search/repository.ts）は
//      case_order_items / loan_return_items を親（case_orders / loan_returns）と !inner 結合し、
//      facility_id を明示条件として入れている。これは RLS（層1）だけに頼らないための層2の防御——
//      admin は RLS を全施設ぶん通るため、これが無いと admin の検索が全施設になってしまう。
//      単体テスト（src/lib/lot-search/__tests__/repository.test.ts）はモックで「絞り込み条件が
//      正しく呼ばれたか」を見ているだけで、**本物の RLS ポリシーの上でも実際に絞られるか**は
//      検証していない。ここは本物のローカル Supabase 上で、admin セッションでも他施設のロットが
//      漏れないことを実測する（P-013「明細は親経由で施設スコープ」の適用範囲）。

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  cleanupFacilitiesAndUsers,
  deleteWhereIn,
  type SeededUser,
} from './helpers/seed-rls-idor'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'
import { searchLotItems } from '../../../src/lib/lot-search/repository'

// WHY(受け入れ条件「aal1で0件を返さない」): has_aal2() は verified な TOTP factor を
//      持たない利用者には TRUE を返す（20260907030000 のコメント参照）ため、この境界は
//      「MFA登録済みだが昇格していないセッション」でしか再現できない。seed-rls-idor.ts の
//      createSeededUser はパスワードを外へ出さないため、ここは
//      require-aal2-in-facility-writer-rls.integration.test.ts と同じやり方で
//      専用のユーザーを自前で作る。
const AAL_TEST_PASSWORD = 'lot-search-aal1-boundary-test-0000'

function createAnonClient(): SupabaseClient {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface Fixtures {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  adminUser: SeededUser
  productId: string
  caseOrderItemAId: string
  loanReturnItemAId: string
  lot: string
  aal: { email: string; userId: string; factorId: string; secret: string }
}

async function seed(): Promise<Fixtures> {
  const serviceClient = createServiceRoleClient()
  const runId = randomUUID()
  const lot = `LOT-IDOR-${runId}`

  const facilityA = await createFacility(serviceClient, `テスト施設A-${runId}`)
  const facilityB = await createFacility(serviceClient, `テスト施設B-${runId}`)

  const userA = await createSeededUser(serviceClient, 'rls-idor-lot-search-user-a', facilityA.id)
  // WHY(2026-09-19 に人が足した): 最初の実装には「他施設の**非 admin** メンバー」が居なかった。
  //      admin のケースは repository の明示条件（層 2）しか測らない。RLS（層 1）が他施設の明細を
  //      隠すことは、RLS を通らない admin では測れないので、施設 B の一般メンバーで測る
  const userB = await createSeededUser(serviceClient, 'rls-idor-lot-search-user-b', facilityB.id)
  // WHY: admin は facilityIdRequired により facilityId を明示して呼ぶ運用（P-002）。
  //      RLS 側は admin を全施設ぶん通すため、施設 B を指定して呼んでも施設 A の行が
  //      混ざらないことこそが層2の防御が効いている証拠になる
  const adminUser = await createSeededUser(serviceClient, 'rls-idor-lot-search-admin', facilityB.id, 'admin')

  const jan = `jan-lot-search-${runId}`
  const { data: product, error: productError } = await serviceClient
    .from('products')
    .insert({ jan, ref: `ref-lot-search-${runId}`, name: `シード用製品-${runId}` })
    .select('id')
    .single()
  if (productError || !product) {
    throw new Error(`[lot-search-rls-idor] products シード作成失敗: ${productError?.message}`)
  }

  const { data: caseOrder, error: caseOrderError } = await serviceClient
    .from('case_orders')
    .insert({
      facility_id: facilityA.id,
      case_datetime: new Date().toISOString(),
      procedure_name: 'シード用術式',
      patient_id: 'IDOR-TEST-PATIENT-LOT',
      patient_initials: 'IDORテスト患者',
      gender: 'other',
      doctor_name: 'IDORテスト医師',
    })
    .select('id')
    .single()
  if (caseOrderError || !caseOrder) {
    throw new Error(`[lot-search-rls-idor] case_orders シード作成失敗: ${caseOrderError?.message}`)
  }

  const { data: loanReturn, error: loanReturnError } = await serviceClient
    .from('loan_returns')
    .insert({ facility_id: facilityA.id, return_datetime: new Date().toISOString() })
    .select('id')
    .single()
  if (loanReturnError || !loanReturn) {
    throw new Error(`[lot-search-rls-idor] loan_returns シード作成失敗: ${loanReturnError?.message}`)
  }

  const { data: caseOrderItem, error: caseOrderItemError } = await serviceClient
    .from('case_order_items')
    .insert({ case_order_id: caseOrder.id, jan, lot, quantity: 1 })
    .select('id')
    .single()
  if (caseOrderItemError || !caseOrderItem) {
    throw new Error(`[lot-search-rls-idor] case_order_items シード作成失敗: ${caseOrderItemError?.message}`)
  }

  const { data: loanReturnItem, error: loanReturnItemError } = await serviceClient
    .from('loan_return_items')
    .insert({ loan_return_id: loanReturn.id, jan, lot, quantity: 1 })
    .select('id')
    .single()
  if (loanReturnItemError || !loanReturnItem) {
    throw new Error(`[lot-search-rls-idor] loan_return_items シード作成失敗: ${loanReturnItemError?.message}`)
  }

  // WHY(aal境界用ユーザー): 施設Aのメンバーとして、MFAを登録した専用ユーザーを作る。
  //      登録直後の enroll セッションではなく、毎回新しくサインインしたクライアントを
  //      aal1/aal2それぞれのテストで使う（既存の require-aal2-in-facility-writer-rls
  //      と同じやり方）。
  const aalRunId = randomUUID()
  const aalEmail = `rls-idor-lot-search-aal-${aalRunId}@example.test`
  const { data: aalUserData, error: aalUserError } = await serviceClient.auth.admin.createUser({
    email: aalEmail,
    password: AAL_TEST_PASSWORD,
    email_confirm: true,
  })
  if (aalUserError || !aalUserData.user) {
    throw new Error(`[lot-search-rls-idor] aal境界用ユーザー作成失敗: ${aalUserError?.message}`)
  }
  const aalUserId = aalUserData.user.id
  const { error: aalLinkError } = await serviceClient
    .from('user_facilities')
    .insert({ user_id: aalUserId, facility_id: facilityA.id, role: 'staff' })
  if (aalLinkError) {
    throw new Error(`[lot-search-rls-idor] aal境界用ユーザーのuser_facilities作成失敗: ${aalLinkError.message}`)
  }
  const aalEnrollClient = createAnonClient()
  await signInAtAal1(aalEnrollClient, aalEmail, AAL_TEST_PASSWORD)
  const { factorId, secret } = await enrollAndVerifyTotp(aalEnrollClient)

  return {
    facilityA,
    facilityB,
    userA,
    userB,
    adminUser,
    productId: product.id as string,
    caseOrderItemAId: caseOrderItem.id as string,
    loanReturnItemAId: loanReturnItem.id as string,
    lot,
    aal: { email: aalEmail, userId: aalUserId, factorId, secret },
  }
}

async function cleanup(f: Fixtures): Promise<void> {
  const serviceClient = createServiceRoleClient()
  await cleanupFacilitiesAndUsers(f.userA, f.adminUser, f.facilityA, f.facilityB)
  await deleteWhereIn(serviceClient, 'products', 'id', [f.productId])
  await serviceClient.auth.admin.deleteUser(f.aal.userId)
  await serviceClient.auth.admin.deleteUser(f.userB.id)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-013 明細は親経由で施設スコープ /
// P-015 自施設は取得できる（対照）。issue #803 の searchLotItems は case_order_items /
// loan_return_items という「親が2種類ある」横断検索だが、どちらの親も同じ facility_id で
// 絞られることをここで守る
describe('ロット検索 searchLotItems RLS/IDOR [P-013 P-015]', () => {
  let fixtures: Fixtures

  beforeAll(async () => {
    fixtures = await seed()
  }, 60_000)

  afterAll(async () => {
    if (fixtures) {
      await cleanup(fixtures)
    }
  })

  it('自施設のユーザーはシード済みのロットを取得できる（対照。P-015）', async () => {
    const result = await searchLotItems(fixtures.userA.client, fixtures.facilityA.id, fixtures.lot)

    const itemIds = result.items.map((i) => i.itemId)
    expect(itemIds).toContain(fixtures.caseOrderItemAId)
    expect(itemIds).toContain(fixtures.loanReturnItemAId)
  })

  // WHY: これが IDOR の本体。route は requireFacilityAccess で非メンバーを 403 にするが、repository は
  //      クライアントから PostgREST へ直接届く問い合わせと同じものを投げる。**施設 A の ID を知っている
  //      他施設の一般メンバー**が repository の条件（facility_id = A）をそのまま満たしても、RLS（層 1）が
  //      親の施設メンバーシップで明細を隠すこと、を実 DB で測る。上の対照（userA なら取れる）と対で読む
  it('他施設の一般メンバーが施設Aを指定して検索しても、施設Aのロットは1件も返らない（層1: RLS。P-013）', async () => {
    const result = await searchLotItems(fixtures.userB.client, fixtures.facilityA.id, fixtures.lot)

    expect(result.items).toEqual([])
    expect(result.truncated).toBe(false)
  })

  it('他施設の一般メンバーが自施設Bで同じロットを検索しても、施設Aのロットは混ざらない（P-013）', async () => {
    const result = await searchLotItems(fixtures.userB.client, fixtures.facilityB.id, fixtures.lot)

    expect(result.items).toEqual([])
  })

  it('admin が施設Bを指定して検索しても、施設Aのロットは1件も混ざらない（層2: repository の明示条件。P-013）', async () => {
    // WHY: admin は RLS（層1）を全施設ぶん通るので、ここで施設Aの行が0件であることこそが
    //      「RLSだけに頼らない」repository側の絞り込みが効いている証拠になる
    const result = await searchLotItems(fixtures.adminUser.client, fixtures.facilityB.id, fixtures.lot)

    const itemIds = result.items.map((i) => i.itemId)
    expect(itemIds).not.toContain(fixtures.caseOrderItemAId)
    expect(itemIds).not.toContain(fixtures.loanReturnItemAId)
    expect(result.items).toEqual([])
  })

  it('admin が施設Aを指定して検索すると、施設Aのロットが取得できる（対照。P-015）', async () => {
    const result = await searchLotItems(fixtures.adminUser.client, fixtures.facilityA.id, fixtures.lot)

    const itemIds = result.items.map((i) => i.itemId)
    expect(itemIds).toContain(fixtures.caseOrderItemAId)
    expect(itemIds).toContain(fixtures.loanReturnItemAId)
  })

  it('戻り値に患者情報の列が含まれない（決定6=(a)）', async () => {
    const result = await searchLotItems(fixtures.userA.client, fixtures.facilityA.id, fixtures.lot)

    const json = JSON.stringify(result)
    expect(json).not.toContain('IDOR-TEST-PATIENT-LOT')
    expect(json.toLowerCase()).not.toContain('patient')
  })

  // WHY: **これは受け入れ条件そのものではない。受け入れ条件が守るべき危険の、DB 層での姿を固定するテスト。**
  //      受け入れ条件（SPEC.md Part 1）は「aal1 で『0 件』を返さない」。明細の SELECT ポリシーは
  //      has_aal2() を要求するので、aal1 のセッションが repository まで届くと RLS が全行を隠し、
  //      **エラーではなく空の結果**になる（下の 1 本目）。ロット検索で空は「該当なし」と読まれる。
  //      repository では変えられないので、受け入れ条件を満たすのは **proxy の MFA ガード**
  //      （matcher が /api/* を含み、aal1 を route に届かせない）で、そちらは
  //      src/__tests__/proxy.test.ts の「ロット検索の API を直接呼ぶ→ route に届かず」が実測している。
  //      ここが緑であること＝「proxy を通らない経路ができたら、ロット検索は黙って 0 件を返す」の証拠なので、
  //      proxy の matcher や MFA ガードを変える人は対で見ること。
  //      （2026-09-19: 最初の実装はこの describe を「受け入れ条件: aal1 では 0 件になる」と、
  //      条件を実測に合わせて逆向きに書いていた。レビューが 3 回差し戻しても直らず、人が直した）
  describe('aal境界の DB 層での姿（aal1 が repository まで届くと空になる。届かせないのは proxy）', () => {
    it('MFA登録済みだがaal1のセッションでは、シード済みのロットが1件も返らない', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, fixtures.aal.email, AAL_TEST_PASSWORD)

      const result = await searchLotItems(client, fixtures.facilityA.id, fixtures.lot)

      expect(result.items).toEqual([])
    })

    it('対照: aal2まで昇格すると、同じユーザー・同じロットで取得できる', async () => {
      const client = createAnonClient()
      await signInAtAal1(client, fixtures.aal.email, AAL_TEST_PASSWORD)
      await stepUpToAal2(client, fixtures.aal.factorId, fixtures.aal.secret)

      const result = await searchLotItems(client, fixtures.facilityA.id, fixtures.lot)

      const itemIds = result.items.map((i) => i.itemId)
      expect(itemIds).toContain(fixtures.caseOrderItemAId)
      expect(itemIds).toContain(fixtures.loanReturnItemAId)
    })
  })
})
