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
// WHY(2026-09-11): 表を割るのは共通エンジンだけに任せる。素の `split('|')` は
//      「列の中のパイプは `\|` と書いてよい」という 2026-09-09 の緩和を知らないため、
//      この表に 1 つ書かれた瞬間に列が 1 つずれた値を黙って読む（C-047）。
import { splitRow } from '../../../scripts/lib/check-catalog.mjs'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  cleanupFacilitiesAndUsers,
  deleteWhereIn,
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
    const cells: string[] = splitRow(line)
    const [id, table, , readers, , , , status] = cells
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
  distributorProductId: string
  /** 後片付け用（施設に紐づかないマスタは施設の削除では消えない） */
  categoryId: string
}

/**
 * **未ログインからの読み取りを「測れていない」表**（2026-09-11 実測）。
 *
 * この掃きが種をまかない表は、走行時に 1 行も無いので「読めなかった」と
 * 「餌が無かった」の区別がつかない（C-021）。区別がつかないものをここに並べ、
 * **増減したら落とす**。減らすには、その表に service role で 1 行まいてから測る。
 */
const ANON_UNMEASURED_TABLES: string[] = []

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

/** 条件に合う行の数を service role で数える（応答ではなく DB の実態を見るため） */
async function countWhere(table: string, column: string, value: string): Promise<number> {
  const { count, error } = await service
    .from(table)
    .select('*', { count: 'exact', head: true })
    .eq(column, value)
  if (error) throw new Error(`[sweep] ${table} の件数取得失敗: ${error.message}`)
  return count ?? 0
}

/** 1 行を丸ごと文字列にする（前後比較用）。行が無ければ null */
async function rowSnapshot(table: string, key: string, value: string): Promise<string | null> {
  const { data, error } = await service.from(table).select('*').eq(key, value)
  if (error) throw new Error(`[sweep] ${table} の読み出し失敗: ${error.message}`)
  if ((data ?? []).length === 0) return null
  return JSON.stringify(data)
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

/**
 * 施設 B の利用者が「施設 A の行を書き換えよう」として試す更新。
 *
 * WHY(表ごとに列を書く): 更新は表ごとに安全な列が違う。数量や状態は業務のトリガー
 *      （返却が貸出を超えない・状態は前へしか進まない）に当たるので、
 *      **境界ではなく業務規則で拒否されて**「守れている」と誤読しかねない。
 *      当たらない列だけを選ぶ。選べない表は下の理由つきで外す。
 */
const FORBIDDEN_UPDATE: Record<string, Record<string, unknown>> = {
  hospital_prices: { purchase_price: 999 },
  consumables: { purpose: '攻撃テストで書き換え' },
  case_orders: { doctor_name: '攻撃テストで書き換え' },
  loan_orders: { maker: '攻撃テストで書き換え' },
  loan_returns: { return_datetime: '2020-01-01T00:00:00.000Z' },
  // 他施設の所属の役割を書き換える＝権限の昇格。境界の中でいちばん被害が大きい
  user_facilities: { role: 'admin' },
}

/** 更新を試さない表と、その理由（削除は全表で試す） */
const UPDATE_NOT_TRIED: Record<string, string> = {
  consumable_orders: '安全に書き換えられる列が無い（status は前へしか進めない業務トリガーに当たり、境界ではなく業務規則で拒否されてしまう）',
  case_order_items: '数量の更新は在庫・金額の業務トリガーに当たる。明細の更新の境界は order-items-rls-idor が親経由の EXISTS として測る（P-011）',
  consumable_order_items: '数量の更新は在庫の業務トリガーに当たる。明細の更新の境界は order-items-rls-idor が測る（P-011）',
  loan_order_items: '数量の更新は未返却数の計算に効く。明細の更新の境界は order-items-rls-idor が測る（P-011）',
  loan_return_items: '数量の更新は「返却が貸出を超えない」トリガーに当たり、境界ではなく業務規則で拒否されてしまう（P-011 が別に測る）',
  price_histories: '追記のみの表で、施設 A の利用者にも更新は許されていない。ここでの「変わらなかった」は境界ではなく追記のみの性質を測ることになる（price-histories-rls-idor が測る）',
  audit_log: '追記のみの表で、誰にも更新は許されていない（append-only トリガー）。境界ではなく追記のみの性質になるので audit-log-rls-idor が測る',
}

/**
 * 施設 B の利用者が「施設 A の行を新しく作ろう」として送る中身。
 * 同じ組み立てを施設 B に対しても使い、**自施設なら通る**ことを対照として測る。
 *
 * WHY(作成だけが読み取りと独立している、2026-09-09 実測): PostgreSQL の RLS では、
 *      `UPDATE ... WHERE` / `DELETE ... WHERE` は**対象の行を SELECT ポリシーで見つけられないと
 *      0 行で終わる**。実際、更新を許すポリシーだけを足しても 0 行のままで、
 *      読み取りも開けて初めて 1 行変わった。つまり更新・削除の「変わらなかった」は
 *      読み取り境界に依存していて、書き込み側の境界を独立には測れない。
 *      **作成（INSERT）は既存の行を読まない**ので、WITH CHECK だけが効く。ここが独立した測り口。
 */
const FORBIDDEN_INSERT: Record<string, (s: Seed, facilityId: string) => Record<string, unknown>> = {
  hospital_prices: (s, f) => ({
    distributor_product_id: s.distributorProductId, facility_id: f, purchase_price: 1, delivery_price: 1,
  }),
  consumables: (s, f) => ({ facility_id: f, name: `攻撃テスト用消耗品-${randomUUID()}`, purpose: '攻撃テスト' }),
}

/** 作成を試さない表と、その理由 */
const INSERT_NOT_TRIED: Record<string, string> = {
  user_facilities: '自分を施設 A の admin にする攻撃は permission-change-authz が測る。ここでは対照が置けない（staff はどこの施設にも所属を足せない設計なので、拒否が境界由来か権限由来か分けられない）',
  // WHY(2026-09-09 に外した): 発注 3 種と返却は、クライアントから作る道そのものを無くした
  //      （20260909040000 で INSERT の権限を剥がした）。誰が叩いても 42501 になるので、
  //      **拒否が施設境界由来か権限由来か分けられない**（対照も置けない＝C-021）。
  //      作成の境界は RPC 側へ移った（rpc-boundary-sweep が施設をまたいで測る）。
  case_orders: '直接 INSERT の道が無い（2026-09-09 に権限ごと剥がした）。作成は create_case_order_atomic だけで、その境界は rpc-boundary-sweep が測る',
  consumable_orders: '直接 INSERT の道が無い（同上）。作成は create_consumable_order_atomic だけで、その境界は rpc-boundary-sweep が測る',
  loan_orders: '直接 INSERT の道が無い（同上）。作成は create_loan_order_atomic だけで、その境界は rpc-boundary-sweep が測る',
  loan_returns: '直接 INSERT の道が無い（同上）。作成は create_loan_return_atomic だけで、その境界は rpc-boundary-sweep が測る',
  case_order_items: '明細は親の id を指定して作る。親が他施設なら EXISTS の中で親を読めず、結局は読み取り境界に依存する（order-items-rls-idor が親経由で測る）',
  consumable_order_items: '同じ理由で読み取り境界に依存する。order-items-rls-idor が親経由で測る',
  loan_order_items: '同じ理由で読み取り境界に依存する。order-items-rls-idor が親経由で測る',
  loan_return_items: '同じ理由で読み取り境界に依存する。order-items-rls-idor が親経由で測る',
  price_histories: '追記のみの表で、クライアントからの INSERT はポリシーで一律に拒否される（施設に関係なく落ちるので境界を測れない）',
  audit_log: '追記のみの表で、監査トリガー（SECURITY DEFINER）だけが書く。クライアントからの INSERT は施設に関係なく落ちる',
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
      distributorProductId, categoryId,
    }
  }, 60_000)

  afterAll(async () => {
    if (!seed) return
    await cleanupFacilitiesAndUsers(seed.userA, seed.userB, seed.facilityA, seed.facilityB)
    // WHY(カテゴリも消す、2026-09-09): 施設を消しても製品・カテゴリは残る（施設に紐づかない）。
    //      ここが抜けていて、緑の実行のたびに残っていた。
    //      仕切値の履歴は親の削除に合わせて DB のトリガーが消す（20260910000000）。
    await deleteWhereIn(service, 'products', 'id', [seed.productId])
    await deleteWhereIn(service, 'categories', 'id', [seed.categoryId])
  }, 60_000)

  it('台帳の全表に「誰から隠すのか」の定義がある（新しい表を作ったら決めさせる）', () => {
    const undefinedTables = tables.filter((t) => !(t.table in FORBIDDEN_ROWS)).map((t) => `${t.id} ${t.table}`)
    expect(undefinedTables, 'FORBIDDEN_ROWS に定義を足す（帯の区分に従って決める）').toEqual([])
    // fail-open 防止: 台帳を読めていない・行が減ったなら落とす
    // 2026-09-09 実測 23 表。減ったら台帳の読み取りが壊れている
    expect(tables.length, '台帳から表を読めていない（掃きが空振りする）').toBeGreaterThanOrEqual(23)
  })

  it('未ログイン（anon）は、台帳が anon を読み手にしていない全表から 1 行も読めない', async () => {
    // WHY(2026-09-11・E-074): ここは長いあいだ「0 行返った＝読めない」と読んでいた。
    //      だが**表が空なら、締まっていても開いていても 0 行**である（C-021）。
    //      この掃きが種をまくのは一部の表だけなので、残りは毎回「餌の無い実行」だった。
    //      権限で弾かれた（error あり）なら確実に締まっているが、エラー無しの 0 行は
    //      **測れていない**——その区別を残す。「測れていない表」は下の ratchet で固定し、
    //      増えたら落とす（緑のまま範囲が痩せていくのを止める）。
    const leaked: string[] = []
    const unmeasured: string[] = []
    for (const t of tables) {
      if (t.readers.includes('anon')) continue
      const { data, error } = await anon.from(t.table).select('*').limit(1)
      if (!error && (data ?? []).length > 0) {
        leaked.push(`${t.id} ${t.table}: ${(data ?? []).length} 行読めた`)
        continue
      }
      if (error) continue // 権限で弾かれた＝確実に締まっている
      const { count, error: countError } = await service
        .from(t.table)
        .select('*', { count: 'exact', head: true })
      if (countError) {
        unmeasured.push(t.table)
        continue
      }
      if ((count ?? 0) === 0) unmeasured.push(t.table)
    }
    expect(leaked, '未ログインで読めた表がある').toEqual([])
    expect(
      unmeasured.sort(),
      '未ログインからの読み取りを測れていない表が変わった（増えたなら種まきを足す。減ったなら一覧から消す）'
    ).toEqual([...ANON_UNMEASURED_TABLES].sort())
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

  it('施設 B の利用者は、施設 A の行を 1 行も書き換えられず・消せない（台帳の施設スコープの全表）', async () => {
    const changed: string[] = []
    const triedUpdate: string[] = []
    const triedDelete: string[] = []

    for (const t of tables) {
      // マスタ（施設に属さない）と、行を用意できない記録・裏方は対象外
      if (t.band === '01' || t.table in NOT_MEASURED_HERE) continue
      const forbidden = await FORBIDDEN_ROWS[t.table](seed)
      if (forbidden.length === 0) continue
      const key = keyOf(t.table)
      const target = forbidden[0]

      // 書き換え
      const patch = FORBIDDEN_UPDATE[t.table]
      if (patch) {
        triedUpdate.push(t.table)
        const before = await rowSnapshot(t.table, key, target)
        await seed.userB.client.from(t.table).update(patch).eq(key, target)
        const after = await rowSnapshot(t.table, key, target)
        // RLS は拒否ではなく 0 行にするので、エラーの有無ではなく**行が変わったか**で判定する
        if (before !== after) changed.push(`${t.id} ${t.table}: 施設 B の更新で行が変わった`)
      }

      // 削除
      triedDelete.push(t.table)
      await seed.userB.client.from(t.table).delete().eq(key, target)
      const stillThere = await rowSnapshot(t.table, key, target)
      if (stillThere === null) changed.push(`${t.id} ${t.table}: 施設 B の削除で行が消えた`)
    }

    expect(changed, '施設 B の利用者が施設 A の行を変えた・消した').toEqual([])

    // fail-open 防止: 試した表が減ったら落とす（2026-09-09 実測: 更新 6 表 / 削除 11 表）
    expect(triedUpdate.length, '更新を試した表が減っている').toBeGreaterThanOrEqual(6)
    expect(triedDelete.length, '削除を試した表が減っている').toBeGreaterThanOrEqual(11)
  }, 60_000)

  it('施設 B の利用者は、施設 A の行を新しく作れない（対照: 自施設なら同じ中身で作れる）', async () => {
    const created: string[] = []
    const controlFailed: string[] = []

    for (const t of tables) {
      const build = FORBIDDEN_INSERT[t.table]
      if (!build) continue

      // 攻撃: 施設 A の行を作る。
      // WHY(応答ではなく DB を見る、2026-09-09 実測): `insert().select()` の RETURNING は
      //      SELECT ポリシーを通るので、**行が入っても応答は空**になる。
      //      応答で判定すると、作れてしまっているのに「作れなかった」と読む（C-020）。
      const before = await countWhere(t.table, 'facility_id', seed.facilityA.id)
      await seed.userB.client.from(t.table).insert(build(seed, seed.facilityA.id))
      const after = await countWhere(t.table, 'facility_id', seed.facilityA.id)
      if (after > before) {
        created.push(`${t.id} ${t.table}: 施設 B の利用者が施設 A の行を作れた（${before} → ${after}）`)
      }

      // 対照: 同じ中身を自施設（施設 B）へ作る。ここが通らないと上の「作れなかった」に意味が無い
      const controlBefore = await countWhere(t.table, 'facility_id', seed.facilityB.id)
      const control = await seed.userB.client.from(t.table).insert(build(seed, seed.facilityB.id))
      const controlAfter = await countWhere(t.table, 'facility_id', seed.facilityB.id)
      if (controlAfter === controlBefore) {
        controlFailed.push(`${t.id} ${t.table}: 自施設にも作れない（${control.error?.message ?? '行が増えない'}）`)
      }
    }

    expect(created, '施設 B の利用者が施設 A の行を作れた').toEqual([])
    expect(controlFailed, '対照が通らないので「作れなかった」に意味が無い（C-021）').toEqual([])
    // fail-open 防止（2026-09-09 実測: 2 表）。
    // WHY(6 → 2 に下げた): 発注 3 種・返却の直接 INSERT の道を無くしたので、
    //      **クライアントが直接作れる施設スコープの表は 2 つだけ**になった。
    //      数を減らしたぶんの穴埋めは下の「決めていない表がある」検査が受け持つ
    //      （施設スコープの表は必ず「試す」か「試さない理由」のどちらかに入る）。
    expect(Object.keys(FORBIDDEN_INSERT).length, '作成を試す表が減っている').toBeGreaterThanOrEqual(2)
  }, 60_000)

  it('作成を試さない表は、理由つきで名前が残っている（限界を隠さない）', () => {
    for (const [table, reason] of Object.entries(INSERT_NOT_TRIED)) {
      expect(reason.length, `${table} の理由が短すぎる`).toBeGreaterThan(20)
    }
    const scoped = tables
      .filter((t) => t.band !== '01' && !(t.table in NOT_MEASURED_HERE))
      .map((t) => t.table)
    const decided = new Set([...Object.keys(FORBIDDEN_INSERT), ...Object.keys(INSERT_NOT_TRIED)])
    expect(scoped.filter((t) => !decided.has(t)), '作成を試すかどうかを決めていない表がある').toEqual([])
  })

  it('対照: 施設 A の利用者は同じ操作ができる（「誰も書けないだけ」で通っていない）', async () => {
    // WHY(対照を置く、C-021): 「変わらなかった」は、境界が効いている場合と
    //      **そもそも誰も書けない場合**の両方で成り立つ。同じ操作が自施設で通ることを見て初めて、
    //      上の検査の「変わらなかった」に意味が出る。
    const before = await rowSnapshot('hospital_prices', 'id', seed.hospitalPriceId)
    const { error: updateError } = await seed.userA.client
      .from('hospital_prices')
      .update({ purchase_price: 654321 })
      .eq('id', seed.hospitalPriceId)
    expect(updateError, '施設 A の利用者が自施設の価格を更新できない').toBeNull()
    const after = await rowSnapshot('hospital_prices', 'id', seed.hospitalPriceId)
    expect(after, '施設 A の利用者の更新が反映されていない').not.toBe(before)

    // 削除も自施設なら通る（消して困らない捨て行を 1 件作って試す）
    const { data: throwaway, error: insertError } = await service
      .from('consumables')
      .insert({ facility_id: seed.facilityA.id, name: `対照用消耗品-${randomUUID()}`, purpose: '対照' })
      .select('id')
      .single()
    expect(insertError, '対照用の行を作れない').toBeNull()
    const throwawayId = String((throwaway as { id: unknown }).id)
    await seed.userA.client.from('consumables').delete().eq('id', throwawayId)
    expect(await rowSnapshot('consumables', 'id', throwawayId), '施設 A の利用者が自施設の行を消せない').toBeNull()
  }, 60_000)

  it('更新を試さない表は、理由つきで名前が残っている（限界を隠さない）', () => {
    for (const [table, reason] of Object.entries(UPDATE_NOT_TRIED)) {
      expect(reason.length, `${table} の理由が短すぎる`).toBeGreaterThan(20)
    }
    // 施設スコープの表は「更新を試す」か「試さない理由がある」かのどちらかに必ず入る
    const scoped = tables
      .filter((t) => t.band !== '01' && !(t.table in NOT_MEASURED_HERE))
      .map((t) => t.table)
    const decided = new Set([...Object.keys(FORBIDDEN_UPDATE), ...Object.keys(UPDATE_NOT_TRIED)])
    expect(scoped.filter((t) => !decided.has(t)), '更新を試すかどうかを決めていない表がある').toEqual([])
  })

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
