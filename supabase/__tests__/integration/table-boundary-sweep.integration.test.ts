// supabase/__tests__/integration/table-boundary-sweep.integration.test.ts
// WHY: 攻撃の総当たり（P-017）は **Next.js の route だけ**を掃いている。
//      だが Supabase の REST は公開 URL + anon key + 利用者の JWT で**ブラウザから直接**叩ける。
//      この入口にはアプリのコードが 1 行も挟まらず、**RLS と GRANT だけが防御**になる。
//      2026-09-09 に実測して確かめた（施設 B の JWT で `/rest/v1/price_histories` を直接叩いた）。
//
//      表ごとの RLS/IDOR テストは 14 本あり、テーブル台帳（TB-xxx）の「守るテスト」列にも
//      1 本ずつ書いてある。**しかしその列が保証しているのは「そのファイルが実在する」ことだけ**で、
//      中身がその表の境界を測っているかは誰も見ていない（`check-catalog.mjs` はパスの実在しか見ない）。
//      ここでは台帳に載っている**全表**を 1 か所で掃き、抜けを構造的に無くす。
//
// 何を測るか（表ごとに 2 つ）:
//   (A) 未ログイン（anon）は 1 行も読めない。台帳の「読み手」に anon が無い表すべてが対象
//   (B) 施設 B の利用者は、施設 A に属する行を 1 行も読めない。
//       「属する」の定義は台帳の ID の帯（区分）から決める:
//         01x マスタ         → 施設に属さない。全員が読める設計なので (B) の対象外
//         02x 施設スコープ   → facility_id が施設 A の行（明細は親をたどる）
//         03x 所属           → facility_id が施設 A の行
//         04x 追記のみの記録 → admin だけが読める表は全行。監査ログは他施設の行
//         05x 監視の裏方     → クライアントロールには 1 行も見せない設計なので全行
//
// ratchet: 台帳に表が増えると、下の `FORBIDDEN_ROWS` に定義が無くて落ちる。
//      **新しい表を作った人に「誰から隠すのか」を必ず 1 回決めさせる**（決め忘れを検査が落とす）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  cleanupFacilitiesAndUsers,
  type SeededUser,
} from './helpers/seed-rls-idor'

const RULEBOOK = path.resolve(__dirname, '../../../docs/agents/table-rulebook.md')

interface RulebookRow {
  id: string
  table: string
  readers: string[]
  band: string
}

/** テーブル台帳（TB-xxx）の行を読む。列は固定 8 列（ID / テーブル / ポリシー / 読み手 / 書き手 / 監査 / 守るテスト / 状態） */
function parseRulebook(): RulebookRow[] {
  const rows: RulebookRow[] = []
  for (const line of readFileSync(RULEBOOK, 'utf8').split('\n')) {
    if (!line.startsWith('| TB-')) continue
    const cells = line.split('|').map((c) => c.trim())
    // cells[0] は行頭の空文字
    const [, id, table, , readers, , , , status] = cells
    if (status !== '実装済み') continue
    rows.push({
      id,
      table,
      readers: readers.split('/').map((r) => r.trim()).filter((r) => r !== 'なし'),
      band: id.slice(3, 5),
    })
  }
  return rows
}

interface Seed {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  caseOrderId: string
  consumableOrderId: string
  loanOrderId: string
  loanReturnId: string
  hospitalPriceId: string
  productId: string
}

let seed: Seed
let service: SupabaseClient
let anon: SupabaseClient

/**
 * 施設 B の利用者に**見えてはいけない**行の id を、表ごとに service role で数え上げる。
 *
 * 空配列を返す表は「その表では測っていない」ことを意味する。
 * 測れた表の数は下の ratchet で固定するので、静かに測らなくなることはできない。
 */
const FORBIDDEN_ROWS: Record<string, (s: Seed) => Promise<string[]>> = {
  // --- 01x マスタ: 施設に属さない。全員が読める設計なので (B) の対象外 ---
  products: async () => [],
  facilities: async () => [],
  distributor_products: async () => [],
  categories: async () => [],
  product_compatibilities: async () => [],

  // --- 02x 施設スコープ: facility_id が施設 A の行 ---
  hospital_prices: (s) => idsWhere('hospital_prices', 'facility_id', s.facilityA.id),
  consumables: (s) => idsWhere('consumables', 'facility_id', s.facilityA.id),
  case_orders: (s) => idsWhere('case_orders', 'facility_id', s.facilityA.id),
  consumable_orders: (s) => idsWhere('consumable_orders', 'facility_id', s.facilityA.id),
  loan_orders: (s) => idsWhere('loan_orders', 'facility_id', s.facilityA.id),
  loan_returns: (s) => idsWhere('loan_returns', 'facility_id', s.facilityA.id),
  // 明細は facility_id 列を持たない。親をたどる（RLS も親経由の EXISTS で守っている）
  case_order_items: (s) => idsWhere('case_order_items', 'case_order_id', s.caseOrderId),
  consumable_order_items: (s) => idsWhere('consumable_order_items', 'consumable_order_id', s.consumableOrderId),
  loan_order_items: (s) => idsWhere('loan_order_items', 'loan_order_id', s.loanOrderId),
  loan_return_items: (s) => idsWhere('loan_return_items', 'loan_return_id', s.loanReturnId),

  // --- 03x 所属 ---
  user_facilities: async (s) => {
    // user_facilities は複合主キーで id 列が無いので、利用者 ID を鍵として扱う
    const { data, error } = await service.from('user_facilities').select('user_id').eq('facility_id', s.facilityA.id)
    if (error) throw new Error(`[sweep] user_facilities の数え上げ失敗: ${error.message}`)
    return (data ?? []).map((r) => String((r as { user_id: unknown }).user_id))
  },

  // --- 04x 追記のみの記録 ---
  // 価格の履歴のうち施設に属するもの（entity_type='hospital_price'）。商品マスタの改定は施設に属さない
  price_histories: async (s) => idsWhere('price_histories', 'entity_id', s.hospitalPriceId),
  // 監査ログは自施設なら読めるので、禁止は「施設 A の行」と「施設に属さない行（admin 専用）」
  audit_log: async (s) => {
    const { data, error } = await service.from('audit_log').select('id, facility_id')
    if (error) throw new Error(`[sweep] audit_log の数え上げ失敗: ${error.message}`)
    return (data ?? [])
      .filter((r) => {
        const fid = (r as { facility_id: unknown }).facility_id
        return fid !== s.facilityB.id
      })
      .map((r) => String((r as { id: unknown }).id))
  },
  // 拒否の記録・特権操作の記録は aal2 の admin だけが読める。staff には全行が禁止
  access_denials: async () => allIds('access_denials'),
  privileged_operations: async () => allIds('privileged_operations'),

  // --- 05x 監視の裏方: クライアントロールには 1 行も見せない設計 ---
  schema_drift_log: async () => allIds('schema_drift_log'),
  schema_baseline_snapshots: async () => allIds('schema_baseline_snapshots'),
  rate_limit_counters: async () => allIds('rate_limit_counters'),
}

async function idsWhere(table: string, column: string, value: string): Promise<string[]> {
  const { data, error } = await service.from(table).select('id').eq(column, value)
  if (error) throw new Error(`[sweep] ${table} の数え上げ失敗: ${error.message}`)
  return (data ?? []).map((r) => String((r as { id: unknown }).id))
}

/**
 * 表ごとの鍵の列名。`id` を持たない表があるので 1 か所に集める
 * （`user_facilities` は複合主キー、`schema_baseline_snapshots` は epoch が主キー）。
 */
const KEY_COLUMN: Record<string, string> = {
  user_facilities: 'user_id',
  schema_baseline_snapshots: 'epoch',
  rate_limit_counters: 'bucket',
}
function keyOf(table: string): string {
  return KEY_COLUMN[table] ?? 'id'
}

async function allIds(table: string): Promise<string[]> {
  const key = keyOf(table)
  const { data, error } = await service.from(table).select(key)
  if (error) throw new Error(`[sweep] ${table} の数え上げ失敗: ${error.message}`)
  return (data ?? []).map((r) => String((r as unknown as Record<string, unknown>)[key]))
}

/**
 * 実際に「見えてはいけない行」を用意できた表。ここに載っている表が測れなくなったら落とす。
 *
 * WHY: 行が 1 つも無い表への「見えなかった」は**何も測っていない**のと同じ。
 *      種まきが壊れて静かに空振りになるのを止める（fail-open 防止）。
 */
const MUST_BE_MEASURED = [
  'hospital_prices', 'consumables', 'case_orders', 'consumable_orders', 'loan_orders', 'loan_returns',
  'case_order_items', 'consumable_order_items', 'loan_order_items', 'loan_return_items',
  'user_facilities', 'price_histories', 'audit_log',
]

/**
 * この掃きでは行を用意できない表と、その理由。
 *
 * WHY(限界を先に書く): 「掃いたので安全」と読まれないように、測れていない表を名前で残す。
 */
const NOT_MEASURED_HERE: Record<string, string> = {
  access_denials: '記録は record_access_denial()（SECURITY DEFINER）経由でしか増えず、この掃きでは作らない。専用の access-denials-rls-idor が測る',
  privileged_operations: '同上（record_privileged_operation() 経由）。privileged-operations-rls-idor が測る',
  schema_drift_log: '書き手が service_role にも無く、record_schema_drift() 経由でしか増えない。schema-drift-rpc-authz が測る',
  schema_baseline_snapshots: '同上（refresh_schema_baseline_snapshot() 経由）',
  rate_limit_counters: '同上（consume_rate_limit() 経由）。rate-limit-rls-idor が測る',
}

const tables = parseRulebook()

// 約束カタログ（docs/agents/promise-catalog.md）: P-018 REST を直接叩かれても表の境界
describe('テーブル台帳の全表を Supabase REST で直接叩く総当たり [P-018]', () => {
  beforeAll(async () => {
    service = createServiceRoleClient()
    anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const runId = randomUUID()
    const facilityA = await createFacility(service, `テスト施設A-${runId}`)
    const facilityB = await createFacility(service, `テスト施設B-${runId}`)
    const userA = await createSeededUser(service, 'table-sweep-user-a', facilityA.id)
    const userB = await createSeededUser(service, 'table-sweep-user-b', facilityB.id)

    const insertOne = async (table: string, row: Record<string, unknown>): Promise<string> => {
      const { data, error } = await service.from(table).insert(row).select('id').single()
      if (error || !data) throw new Error(`[sweep] ${table} のシード失敗: ${error?.message}`)
      return String((data as { id: unknown }).id)
    }

    const jan = `sweep-jan-${runId}`
    const productId = await insertOne('products', { jan, ref: `sweep-ref-${runId}`, name: `掃き取り用製品-${runId}` })
    const categoryId = await insertOne('categories', { name: `掃き取り用カテゴリ-${runId}` })
    const distributorProductId = await insertOne('distributor_products', {
      product_id: productId, category_id: categoryId, maker: `掃き取り用メーカー-${runId}`,
      supplier: `掃き取り用卸-${runId}`, name: `掃き取り用代理店商品-${runId}`, quantity: 1,
    })

    const caseOrderId = await insertOne('case_orders', {
      facility_id: facilityA.id, case_datetime: new Date().toISOString(), procedure_name: '掃き取り用術式',
      patient_id: 'SWEEP-PATIENT-0000', patient_initials: '掃き取り患者', gender: 'other', doctor_name: '掃き取り医師',
    })
    const consumableOrderId = await insertOne('consumable_orders', { facility_id: facilityA.id })
    const loanOrderId = await insertOne('loan_orders', {
      facility_id: facilityA.id, procedure_name: '掃き取り用術式', maker: '掃き取り用メーカー',
    })
    const loanReturnId = await insertOne('loan_returns', {
      facility_id: facilityA.id, return_datetime: new Date().toISOString(),
    })
    const consumableId = await insertOne('consumables', {
      facility_id: facilityA.id, name: `掃き取り用消耗品-${runId}`, purpose: '掃き取り',
    })

    await insertOne('case_order_items', { case_order_id: caseOrderId, jan, quantity: 1 })
    await insertOne('consumable_order_items', { consumable_order_id: consumableOrderId, consumable_id: consumableId, quantity: 1 })
    await insertOne('loan_order_items', { loan_order_id: loanOrderId, jan, name: '掃き取り用品目', quantity: 1 })
    await insertOne('loan_return_items', { loan_return_id: loanReturnId, jan, quantity: 1 })

    // 院内価格は作ったあと**値を変える**。価格履歴は値が変わったときだけ 1 行残る（I-041）
    const hospitalPriceId = await insertOne('hospital_prices', {
      distributor_product_id: distributorProductId, facility_id: facilityA.id,
      purchase_price: 100000, delivery_price: 200000,
    })
    const { error: updateError } = await service
      .from('hospital_prices').update({ purchase_price: 123456 }).eq('id', hospitalPriceId)
    if (updateError) throw new Error(`[sweep] 価格改定のシード失敗: ${updateError.message}`)

    seed = {
      facilityA, facilityB, userA, userB,
      caseOrderId, consumableOrderId, loanOrderId, loanReturnId, hospitalPriceId, productId,
    }
  }, 60_000)

  afterAll(async () => {
    if (!seed) return
    await cleanupFacilitiesAndUsers(seed.userA, seed.userB, seed.facilityA, seed.facilityB)
    await service.from('products').delete().eq('id', seed.productId)
  }, 60_000)

  it('台帳の全表に「誰から隠すのか」の定義がある（新しい表を作ったら決めさせる）', () => {
    const undefinedTables = tables.filter((t) => !(t.table in FORBIDDEN_ROWS)).map((t) => `${t.id} ${t.table}`)
    expect(undefinedTables, 'FORBIDDEN_ROWS に定義を足す（帯の区分に従って決める）').toEqual([])
    // fail-open 防止: 台帳を読めていない・行が減ったなら落とす
    // 2026-09-09 実測 23 表。減ったら台帳の読み取りが壊れている
    expect(tables.length, '台帳から表を読めていない（掃きが空振りする）').toBeGreaterThanOrEqual(23)
  })

  it('未ログイン（anon）は、台帳が anon を読み手にしていない全表から 1 行も読めない', async () => {
    const leaked: string[] = []
    for (const t of tables) {
      if (t.readers.includes('anon')) continue
      const { data, error } = await anon.from(t.table).select('*').limit(1)
      if (!error && (data ?? []).length > 0) leaked.push(`${t.id} ${t.table}: ${(data ?? []).length} 行読めた`)
    }
    expect(leaked, '未ログインで読めた表がある').toEqual([])
  })

  it('施設 B の利用者は、施設 A に属する行を 1 行も読めない（台帳の全表）', async () => {
    const leaked: string[] = []
    const measured: string[] = []
    for (const t of tables) {
      const forbidden = await FORBIDDEN_ROWS[t.table](seed)
      if (forbidden.length > 0) measured.push(t.table)
      if (forbidden.length === 0) continue

      const key = keyOf(t.table)
      const { data, error } = await seed.userB.client.from(t.table).select(key)
      // 読めないこと自体（エラー）は望ましい結果なので、ここでは漏れの有無だけを見る
      if (error) continue
      const visible = new Set((data ?? []).map((r) => String((r as unknown as Record<string, unknown>)[key])))
      const hit = forbidden.filter((id) => visible.has(id))
      if (hit.length > 0) leaked.push(`${t.id} ${t.table}: ${hit.length} 行が施設 B から見えた`)
    }
    expect(leaked, '施設 B の利用者に施設 A の行が見えた').toEqual([])

    // fail-open 防止: 測れるはずの表が測れなくなったら落とす
    const missing = MUST_BE_MEASURED.filter((t) => !measured.includes(t))
    expect(missing, '種まきが壊れて「見えてはいけない行」が用意できていない（空振り）').toEqual([])
  }, 60_000)

  it('この掃きで測れない表は、理由つきで名前が残っている（限界を隠さない）', () => {
    const unmeasurable = tables.map((t) => t.table).filter((t) => t in NOT_MEASURED_HERE)
    for (const t of unmeasurable) {
      expect(NOT_MEASURED_HERE[t].length, `${t} の理由が短すぎる`).toBeGreaterThan(20)
    }
    // 測る表と測らない表を足すと台帳の全表になる（どちらにも入らない表を作らせない）
    const covered = new Set([...MUST_BE_MEASURED, ...Object.keys(NOT_MEASURED_HERE)])
    const master = tables.filter((t) => t.band === '01').map((t) => t.table)
    const uncovered = tables.map((t) => t.table).filter((t) => !covered.has(t) && !master.includes(t))
    expect(uncovered, 'measured にも「測れない理由」にも無い表がある').toEqual([])
  })
})
