// supabase/__tests__/integration/operation-authz-sweep.integration.test.ts
//
// WHY(2026-09-09): 操作の契約（`docs/agents/operation-contracts.md`、O-xxx）の
//      **認可の列だけが、実態と突き合わされていなかった**。
//      `scripts/lib/check-operation-contracts.mjs` は「入口があるか」「権限があるか」までは見るが、
//      **誰が・どの施設に対して・どの認証強度で** できるかは静的には分からない。
//      だからここで実 DB を叩いて測る。
//
//      1 行の宣言（「施設 writer + aal2」等）から**立場ごとの期待値を導出**するので、
//      契約に行を足すと自動で測定対象が増える（宣言 35 行 → 実測 200 件超）。
//      語彙に無い認可を書くと `check-operation-contracts` が先に落とす。
//
// 立場（6 つ）:
//   - anon         … 未ログイン
//   - viewerA      … 施設 A の viewer（読めるが書けない）
//   - staffA_aal1  … 施設 A の staff。**MFA を登録済みで昇格していない**（has_aal2() が偽）
//   - staffA       … 施設 A の staff（MFA 未登録なので has_aal2() は真）
//   - staffB       … 施設 B の staff（他施設）
//   - adminAal2    … admin（is_admin() は所属施設を見ないので全施設に届く）
//
// 何を見るか（操作 × 立場）:
//   - 許されるはずの立場 → 実際に通る（対照。これが無いと「誰も書けないだけ」でも緑になる。C-021）
//   - 許されないはずの立場 → 通らない。かつ**どの層で止まったか**まで見る:
//       権限が無い          … permission denied（GRANT が無い）
//       RLS で止まった      … INSERT は violates row-level security、UPDATE / DELETE は **0 行**
//     PostgREST は権限も RLS も同じ 42501 を返すので、文言で見分ける（helpers/pg-error.ts）。
//
// 限界:
//   - 立場の切り方は人が決める。ここに無い立場（別の admin、退職直後のセッション）は測っていない
//   - `直接書き込み: 禁止` の操作は**全員が権限で止まる**ことだけを見る。
//     その操作の認可は RPC 側にあり、`require-aal2-for-order-rpcs` と `rpc-boundary-sweep` が測る
//   - 読み取り（SELECT）は対象外（P-010〜P-018 と table-boundary-sweep の担当）

import { readFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  type SeededUser,
} from './helpers/seed-rls-idor'
import { enrollAndVerifyTotp } from './helpers/mfa-totp'
import { describeDenial, isPermissionDenied, isRlsRejected } from './helpers/pg-error'

const CONTRACTS = path.resolve(__dirname, '../../../docs/agents/operation-contracts.md')
// WHY(助っ人と同じ値にする): `createSeededUser` が使う定数と違うと `signInWithPassword` が
//      失敗し、**未ログインのまま**のクライアントができる。エラーを見ないと
//      「aal1 だから拒否された」と読み違える（C-020。実際に一度そう読んだ）
const TEST_USER_PASSWORD = 'rls-idor-test-password-0000'

type PersonaId = 'anon' | 'viewerA' | 'staffA_aal1' | 'staffA' | 'staffB' | 'adminAal2'
const PERSONAS: PersonaId[] = ['anon', 'viewerA', 'staffA_aal1', 'staffA', 'staffB', 'adminAal2']

/**
 * 認可の語 1 つから「通ってよい立場」を決める。
 *
 * WHY(admin がどこにでも入る): `is_admin()` は所属施設を見ない（blast-radius B-004）。
 *      施設スコープの操作でも admin は通る、というのが現在の設計。
 */
const ALLOWED_BY_AUTHORIZATION: Record<string, PersonaId[]> = {
  '施設 writer + aal2': ['staffA', 'adminAal2'],
  '親の施設 writer + aal2': ['staffA', 'adminAal2'],
  'admin + aal2': ['adminAal2'],
  // facilities の更新だけ aal2 を要求しない（20260806000002 の明示的な除外判断）
  '施設 writer': ['staffA_aal1', 'staffA', 'adminAal2'],
}

interface Contract {
  id: string
  table: string
  operation: 'INSERT' | 'UPDATE' | 'DELETE'
  directWrite: '許可' | '禁止'
  authorization: string
  state: string
}

function parseContracts(): Contract[] {
  const rows: Contract[] = []
  for (const line of readFileSync(CONTRACTS, 'utf8').split('\n')) {
    if (!line.startsWith('| O-')) continue
    const c = line.split('|').map((x) => x.trim())
    const [, id, table, operation, , directWrite, authorization, , state] = c
    rows.push({
      id,
      table,
      operation: operation as Contract['operation'],
      directWrite: directWrite as Contract['directWrite'],
      authorization,
      state,
    })
  }
  return rows.filter((r) => r.state === '実装済み')
}

interface Sweep {
  service: SupabaseClient
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  clients: Record<PersonaId, SupabaseClient>
  users: SeededUser[]
  /** 施設 A に属する、書き換え・削除の的になる行の id */
  targets: Record<string, string>
  /** INSERT の行を組み立てるのに要る外部キー */
  refs: { jan: string; productId: string; secondProductId: string; categoryId: string; distributorProductId: string; consumableId: string }
  runId: string
}

let s: Sweep

/**
 * 表ごとの「施設 A に対する書き込み」の作り方。
 *
 * ratchet: 契約に表が増えると、ここに定義が無くて落ちる
 * （**新しい操作を足した人に、立場ごとの実測を必ず 1 回通らせる**）。
 */
type Attempt = (client: SupabaseClient) => PromiseLike<{ data: unknown; error: { code?: string | null; message?: string | null } | null }>

function insertAttempt(table: string, row: (sw: Sweep) => Record<string, unknown>): Attempt {
  return (client) => client.from(table).insert(row(s)).select('*')
}
function updateAttempt(table: string, patch: Record<string, unknown>, targetKey: string): Attempt {
  return (client) => client.from(table).update(patch).eq('id', s.targets[targetKey]).select('id')
}
function deleteAttempt(table: string, targetKey: string): Attempt {
  return (client) => client.from(table).delete().eq('id', s.targets[targetKey]).select('id')
}

/** 契約 1 行 → その操作を試す関数。キーは `<表>.<操作>` */
const ATTEMPTS: Record<string, Attempt> = {
  // --- 発注・返却（直接書き込み禁止。全員が権限で止まるはず） ---
  'case_orders.INSERT': insertAttempt('case_orders', (sw) => ({
    facility_id: sw.facilityA.id, case_datetime: new Date().toISOString(), procedure_name: '掃きテスト術式',
    patient_id: 'SWEEP-0001', patient_initials: '掃き', gender: 'other', doctor_name: '掃きテスト医師',
  })),
  'consumable_orders.INSERT': insertAttempt('consumable_orders', (sw) => ({ facility_id: sw.facilityA.id })),
  'loan_orders.INSERT': insertAttempt('loan_orders', (sw) => ({
    facility_id: sw.facilityA.id, procedure_name: '掃きテスト術式', maker: '掃きテストメーカー',
  })),
  'loan_returns.INSERT': insertAttempt('loan_returns', (sw) => ({
    facility_id: sw.facilityA.id, return_datetime: new Date().toISOString(),
  })),
  'case_order_items.INSERT': insertAttempt('case_order_items', (sw) => ({
    case_order_id: sw.targets.caseOrder, jan: sw.refs.jan, quantity: 1,
  })),
  'consumable_order_items.INSERT': insertAttempt('consumable_order_items', (sw) => ({
    consumable_order_id: sw.targets.consumableOrder, consumable_id: sw.refs.consumableId, quantity: 1,
  })),
  'loan_order_items.INSERT': insertAttempt('loan_order_items', (sw) => ({
    loan_order_id: sw.targets.loanOrder, name: '掃きテスト器械', quantity: 1,
  })),
  'loan_return_items.INSERT': insertAttempt('loan_return_items', (sw) => ({
    loan_return_id: sw.targets.loanReturn, jan: sw.refs.jan, quantity: 1,
  })),

  // --- 取り消し（UPDATE。施設の writer + aal2） ---
  'case_orders.UPDATE': updateAttempt('case_orders', { status: 'cancelled' }, 'caseOrder'),
  'consumable_orders.UPDATE': updateAttempt('consumable_orders', { status: 'cancelled' }, 'consumableOrder'),
  'loan_orders.UPDATE': updateAttempt('loan_orders', { status: 'cancelled' }, 'loanOrder'),
  'loan_returns.UPDATE': updateAttempt('loan_returns', { status: 'cancelled' }, 'loanReturn'),
  'loan_return_items.UPDATE': updateAttempt('loan_return_items', { status: 'cancelled' }, 'loanReturnItem'),

  // --- 施設スコープのデータ ---
  'consumables.INSERT': insertAttempt('consumables', (sw) => ({
    facility_id: sw.facilityA.id, name: `掃きテスト消耗品-${randomUUID()}`, purpose: '掃きテスト',
  })),
  'consumables.UPDATE': updateAttempt('consumables', { purpose: '掃きテスト（更新）' }, 'consumable'),
  'consumables.DELETE': deleteAttempt('consumables', 'consumableToDelete'),
  // WHY(価格の付いていない代理店商品を使う): (施設, 代理店商品) は UNIQUE。
  //      種まき済みのものを使うと 23505 で落ち、**認可ではなく重複で拒否された**ことになる
  'hospital_prices.INSERT': insertAttempt('hospital_prices', (sw) => ({
    facility_id: sw.facilityA.id, distributor_product_id: sw.targets.freeDistributorProduct,
    purchase_price: 1, delivery_price: 2,
  })),
  'hospital_prices.UPDATE': updateAttempt('hospital_prices', { purchase_price: 777 }, 'hospitalPrice'),
  'hospital_prices.DELETE': deleteAttempt('hospital_prices', 'hospitalPriceToDelete'),

  // --- 全社マスタ（admin + aal2） ---
  'products.INSERT': insertAttempt('products', () => ({
    jan: `sweep-${randomUUID()}`, ref: `sweep-ref-${randomUUID()}`, name: '掃きテスト製品',
  })),
  'products.UPDATE': updateAttempt('products', { name: '掃きテスト製品（更新）' }, 'product'),
  'products.DELETE': deleteAttempt('products', 'productToDelete'),
  'categories.INSERT': insertAttempt('categories', () => ({ name: `掃きテストカテゴリ-${randomUUID()}` })),
  'categories.UPDATE': updateAttempt('categories', { description: '掃きテスト（更新）' }, 'category'),
  'categories.DELETE': deleteAttempt('categories', 'categoryToDelete'),
  'distributor_products.INSERT': insertAttempt('distributor_products', (sw) => ({
    product_id: sw.refs.productId, category_id: sw.refs.categoryId, maker: '掃きメーカー',
    supplier: '掃き仕入先', name: `掃きテスト商品-${randomUUID()}`, reimbursement_price: 100, quantity: 1,
  })),
  'distributor_products.UPDATE': updateAttempt('distributor_products', { maker: '掃きメーカー（更新）' }, 'distributorProduct'),
  'distributor_products.DELETE': deleteAttempt('distributor_products', 'distributorProductToDelete'),
  // WHY(組を並べ替える): `ordered_pair` の CHECK が product_id_1 < product_id_2 を要求する
  'product_compatibilities.INSERT': insertAttempt('product_compatibilities', (sw) => {
    const [a, b] = [sw.refs.productId, sw.refs.secondProductId].sort()
    return { category_id: sw.refs.categoryId, product_id_1: a, product_id_2: b }
  }),
  'product_compatibilities.DELETE': deleteAttempt('product_compatibilities', 'compatibility'),

  // --- 施設と所属 ---
  'facilities.INSERT': insertAttempt('facilities', () => ({ name: `掃きテスト施設-${randomUUID()}` })),
  'facilities.UPDATE': updateAttempt('facilities', { name: `掃きテスト施設（更新）-${randomUUID()}` }, 'facilityA'),
  'user_facilities.INSERT': (client) =>
    client.from('user_facilities').insert({ user_id: s.targets.spareUser, facility_id: s.facilityA.id, role: 'staff' }).select('user_id'),
  'user_facilities.UPDATE': (client) =>
    client.from('user_facilities').update({ role: 'viewer' }).eq('user_id', s.targets.linkedUser).eq('facility_id', s.facilityA.id).select('user_id'),
  'user_facilities.DELETE': (client) =>
    client.from('user_facilities').delete().eq('user_id', s.targets.linkedUser).eq('facility_id', s.facilityA.id).select('user_id'),
}

const contracts = parseContracts()

describe('操作 × 立場の総当たり（認可の列を実 DB で測る） [O-xxx]', () => {
  beforeAll(async () => {
    const service = createServiceRoleClient()
    const runId = randomUUID()
    const facilityA = await createFacility(service, `掃きテスト施設A-${runId}`)
    const facilityB = await createFacility(service, `掃きテスト施設B-${runId}`)

    const viewerA = await createSeededUser(service, 'authz-sweep-viewer-a', facilityA.id, 'viewer')
    const staffA = await createSeededUser(service, 'authz-sweep-staff-a', facilityA.id, 'staff')
    const staffB = await createSeededUser(service, 'authz-sweep-staff-b', facilityB.id, 'staff')
    const adminUser = await createSeededUser(service, 'authz-sweep-admin', facilityB.id, 'admin')
    // MFA を登録した staff（登録すると has_aal2() は昇格するまで偽になる）
    const staffAal1 = await createSeededUser(service, 'authz-sweep-staff-aal1', facilityA.id, 'staff')
    await enrollAndVerifyTotp(staffAal1.client)
    // 登録したので、いま持っているセッションは aal1 のまま（再サインインして aal1 を確定させる）
    const aal1Client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: aal1SignInError } = await aal1Client.auth.signInWithPassword({
      email: staffAal1.email,
      password: TEST_USER_PASSWORD,
    })
    if (aal1SignInError) throw new Error(`[authz-sweep] aal1 のサインイン失敗: ${aal1SignInError.message}`)
    // 所属だけあって的にされるユーザー（user_facilities の UPDATE / DELETE の的）
    const linked = await createSeededUser(service, 'authz-sweep-linked', facilityA.id, 'staff')
    const { data: spare } = await service.auth.admin.createUser({
      email: `authz-sweep-spare-${runId}@example.test`,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })

    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const one = async (table: string, row: Record<string, unknown>, key = 'id'): Promise<string> => {
      const { data, error } = await service.from(table).insert(row).select(key).single()
      if (error || !data) throw new Error(`[authz-sweep] ${table} のシード失敗: ${error?.message}`)
      return String((data as unknown as Record<string, unknown>)[key])
    }

    const jan = `sweep-jan-${runId}`
    const productId = await one('products', { jan, ref: `sweep-ref-${runId}`, name: '掃きテスト製品' })
    const secondProductId = await one('products', { jan: `sweep-jan2-${runId}`, ref: `sweep-ref2-${runId}`, name: '掃きテスト製品2' })
    const productToDelete = await one('products', { jan: `sweep-jan3-${runId}`, ref: `sweep-ref3-${runId}`, name: '掃きテスト製品3' })
    const categoryId = await one('categories', { name: `掃きテストカテゴリ-${runId}` })
    const categoryToDelete = await one('categories', { name: `掃きテストカテゴリ削除用-${runId}` })
    const distributorProductId = await one('distributor_products', {
      product_id: productId, category_id: categoryId, maker: '掃きメーカー', supplier: '掃き仕入先',
      name: `掃きテスト商品-${runId}`, reimbursement_price: 100, quantity: 1,
    })
    const distributorProductToDelete = await one('distributor_products', {
      product_id: secondProductId, category_id: categoryId, maker: '掃きメーカー', supplier: '掃き仕入先',
      name: `掃きテスト商品削除用-${runId}`, reimbursement_price: 100, quantity: 1,
    })
    // WHY(消される製品を参照しない): product_compatibilities は products への ON DELETE CASCADE。
    //      `productToDelete` を組に入れると、O-042（products.DELETE）の対照が通った瞬間に
    //      **互換の的が連鎖で消え**、O-054 の対照が「0 行」で落ちる（実測して直した）
    const compatLeft = await one('products', { jan: `sweep-jan4-${runId}`, ref: `sweep-ref4-${runId}`, name: '掃きテスト製品4' })
    const compatRight = await one('products', { jan: `sweep-jan5-${runId}`, ref: `sweep-ref5-${runId}`, name: '掃きテスト製品5' })
    const [compatA, compatB] = [compatLeft, compatRight].sort()
    const compatibility = await one('product_compatibilities', {
      category_id: categoryId, product_id_1: compatA, product_id_2: compatB,
    })
    // 院内価格をまだ持たない代理店商品（INSERT の的）
    const freeDistributorProduct = await one('distributor_products', {
      product_id: compatLeft, category_id: categoryId, maker: '掃きメーカー', supplier: '掃き仕入先',
      name: `掃きテスト商品未価格-${runId}`, reimbursement_price: 100, quantity: 1,
    })
    const consumableId = await one('consumables', { facility_id: facilityA.id, name: `掃きテスト消耗品-${runId}`, purpose: '掃き' })
    const consumableToDelete = await one('consumables', { facility_id: facilityA.id, name: `掃きテスト消耗品削除用-${runId}`, purpose: '掃き' })
    const hospitalPrice = await one('hospital_prices', {
      facility_id: facilityA.id, distributor_product_id: distributorProductId, purchase_price: 1, delivery_price: 2,
    })
    const hospitalPriceToDelete = await one('hospital_prices', {
      facility_id: facilityA.id, distributor_product_id: distributorProductToDelete, purchase_price: 1, delivery_price: 2,
    })
    const caseOrder = await one('case_orders', {
      facility_id: facilityA.id, case_datetime: new Date().toISOString(), procedure_name: '掃きテスト術式',
      patient_id: 'SWEEP-SEED', patient_initials: '掃き', gender: 'other', doctor_name: '掃きテスト医師',
    })
    const consumableOrder = await one('consumable_orders', { facility_id: facilityA.id })
    const loanOrder = await one('loan_orders', { facility_id: facilityA.id, procedure_name: '掃きテスト術式', maker: '掃きメーカー' })
    const loanReturn = await one('loan_returns', { facility_id: facilityA.id, return_datetime: new Date().toISOString() })
    const loanReturnItem = await one('loan_return_items', { loan_return_id: loanReturn, jan, quantity: 1 })

    s = {
      service,
      facilityA,
      facilityB,
      clients: {
        anon,
        viewerA: viewerA.client,
        staffA_aal1: aal1Client,
        staffA: staffA.client,
        staffB: staffB.client,
        adminAal2: adminUser.client,
      },
      users: [viewerA, staffA, staffB, adminUser, staffAal1, linked],
      targets: {
        caseOrder, consumableOrder, loanOrder, loanReturn, loanReturnItem,
        consumable: consumableId, consumableToDelete,
        hospitalPrice, hospitalPriceToDelete,
        product: productId, productToDelete,
        category: categoryId, categoryToDelete,
        distributorProduct: distributorProductId, distributorProductToDelete,
        compatibility, compatLeft, compatRight, freeDistributorProduct,
        facilityA: facilityA.id,
        linkedUser: linked.id,
        spareUser: spare!.user!.id,
      },
      refs: { jan, productId, secondProductId, categoryId, distributorProductId, consumableId },
      runId,
    }
  }, 180_000)

  afterAll(async () => {
    if (!s) return
    // 的にした行はまとめて消す（施設を消すと施設スコープの行は連鎖で消える）
    await s.service.from('product_compatibilities').delete().eq('id', s.targets.compatibility)
    for (const u of s.users) await s.service.auth.admin.deleteUser(u.id)
    await s.service.auth.admin.deleteUser(s.targets.spareUser)
    await s.service.from('facilities').delete().in('id', [s.facilityA.id, s.facilityB.id])
    await s.service
      .from('distributor_products')
      .delete()
      .in('id', [s.targets.distributorProduct, s.targets.distributorProductToDelete, s.targets.freeDistributorProduct])
    await s.service.from('categories').delete().in('id', [s.targets.category, s.targets.categoryToDelete])
    await s.service
      .from('products')
      .delete()
      .in('id', [s.targets.product, s.refs.secondProductId, s.targets.productToDelete, s.targets.compatLeft, s.targets.compatRight])
  }, 120_000)

  it('契約の全操作に、実際に試す方法が定義されている（ratchet）', () => {
    const missing = contracts.filter((c) => !ATTEMPTS[`${c.table}.${c.operation}`]).map((c) => `${c.id} ${c.table}.${c.operation}`)
    expect(missing, '契約に操作が増えたのに、掃きで試す方法が無い（ATTEMPTS に足す）').toEqual([])
    // fail-open 防止: 契約を読めていないと 0 件で緑になる
    expect(contracts.length, '契約の行を読めていない').toBeGreaterThanOrEqual(30)
  })

  it('認可の語がすべて期待値を持っている（語を足したら掃きにも足す）', () => {
    const unknown = [...new Set(contracts.map((c) => c.authorization))].filter((a) => !ALLOWED_BY_AUTHORIZATION[a])
    expect(unknown, '掃き側に期待値の無い認可の語がある').toEqual([])
  })

  it(
    '許されない立場は 1 件も書けない。許される立場は書ける（対照）',
    async () => {
      const leaks: string[] = []
      const controlFailed: string[] = []
      const wrongLayer: string[] = []
      let probes = 0

      for (const c of contracts) {
        const attempt = ATTEMPTS[`${c.table}.${c.operation}`]
        if (!attempt) continue
        // WHY(禁止の操作は全員が拒否): クライアント権限そのものが無いので、
        //      許される立場が 1 つも無い。RPC 側の認可は別のテストが測る
        const allowed = c.directWrite === '禁止' ? [] : (ALLOWED_BY_AUTHORIZATION[c.authorization] ?? [])

        for (const persona of PERSONAS) {
          const client = s.clients[persona]
          const shouldPass = allowed.includes(persona)
          // 対照は 1 立場だけにする（admin は全操作で通るので、毎回試すと後片付けが倍になる）
          if (shouldPass && persona !== allowed[0]) continue

          probes += 1
          const { data, error } = await attempt(client)
          const rows = Array.isArray(data) ? data.length : data ? 1 : 0

          if (shouldPass) {
            if (error || rows === 0) {
              controlFailed.push(`${c.id} ${c.table}.${c.operation} / ${persona}: 通るはずが通らない（${describeDenial(error)}）`)
            }
            continue
          }

          if (!error && rows > 0) {
            leaks.push(`${c.id} ${c.table}.${c.operation} / ${persona}: 書けてしまった`)
            continue
          }
          // どの層で止まったか。**「0 行」と「拒否」を混同しない**
          const stoppedByPrivilege = isPermissionDenied(error)
          const stoppedByRls = isRlsRejected(error) || (!error && rows === 0)
          if (!stoppedByPrivilege && !stoppedByRls) {
            wrongLayer.push(`${c.id} ${c.table}.${c.operation} / ${persona}: 権限でも RLS でもない理由で止まった（${describeDenial(error)}）`)
          }
          if (c.directWrite === '禁止' && !stoppedByPrivilege) {
            wrongLayer.push(`${c.id} ${c.table}.${c.operation} / ${persona}: 禁止の操作なのに権限で止まっていない（${describeDenial(error)}）`)
          }
        }
      }

      expect(leaks, '許されない立場が書けてしまった').toEqual([])
      expect(controlFailed, '許される立場が書けない（対照が通らないと「書けなかった」に意味が無い。C-021）').toEqual([])
      expect(wrongLayer, '止まった層が期待と違う').toEqual([])
      // fail-open 防止: 1 件も叩いていないと緑になる
      expect(probes, '掃きが 1 件も操作を試していない').toBeGreaterThan(100)
    },
    300_000
  )
})
