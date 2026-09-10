// supabase/__tests__/integration/rpc-boundary-sweep.integration.test.ts
// WHY: 入口は 3 つある。Next.js の route（P-017）・表への直接アクセス（P-018）・そして **RPC**。
//      RPC は `SECURITY DEFINER` が多く、**RLS を通らない**ので、関数の中に手で書いた検査だけが境界になる。
//      1 本の書き忘れが全面迂回になる、いちばん consequences の大きい入口。
//
//      既に ratchet はある（`constraint-coverage-baseline.json` の `rpcWithoutBoundaryTest`、
//      2026-09-09 時点で 0 本）。**しかしその判定は「テストのどこかに `rpc('名前'` という文字列が
//      出るか」**で、自施設で成功することだけを見た肯定的なテストでも「境界テストあり」になる
//      （`check-design-pitfalls.md` の C-011）。
//      ここでは公開されている全 RPC を**実際に他施設の利用者と未ログインで叩き**、
//      応答に施設 A の目印が出ないこと・施設 A の行が変わらないことを測る。
//
// ratchet: 公開されている RPC は migration から機械列挙する（同じエンジンを ratchet と共有）。
//      新しく公開された RPC は下の `RPC_ATTACKS` に無くて落ちる。
//
// 空振り防止: PostgREST は引数の形が合わないと PGRST202（関数が見つからない）を返す。
//      これは「守れている」ではなく「一度も届いていない」なので、見つけたら落とす（C-023）。

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readdirSync, readFileSync, existsSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { findExposedRpcWithoutBoundaryTest } from '../../../.claude/workflows/lib/constraint-coverage.js'
import {
  createServiceRoleClient,
  createFacility,
  createSeededUser,
  cleanupFacilitiesAndUsers,
  deleteWhereIn,
  type SeededUser,
} from './helpers/seed-rls-idor'

const REPO_ROOT = path.resolve(__dirname, '../../..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations')

/** migration から「クライアントロールが呼べる RPC」を列挙する（ratchet と同じエンジン） */
function exposedRpcNames(): string[] {
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf-8') }))
  const collect = (dirs: string[]): string => {
    const chunks: string[] = []
    const walk = (dir: string) => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (e.name.endsWith('.ts')) chunks.push(readFileSync(full, 'utf-8'))
      }
    }
    dirs.forEach(walk)
    return chunks.join('\n').toLowerCase()
  }
  const result = findExposedRpcWithoutBoundaryTest({
    migrations,
    boundaryTestSource: collect([path.join(REPO_ROOT, 'supabase/__tests__/integration')]),
    appSource: collect([path.join(REPO_ROOT, 'src/lib'), path.join(REPO_ROOT, 'src/app')]),
  }) as { exposed: string[]; unsupported: string[] }
  return result.exposed
}

interface Seed {
  facilityA: { id: string; name: string }
  facilityB: { id: string; name: string }
  userA: SeededUser
  userB: SeededUser
  jan: string
  distributorProductId: string
  /** 後片付け用（施設に紐づかないマスタは連鎖では消えない） */
  productId: string
  categoryId: string
  patientId: string
  procedureName: string
  purchasePrice: number
}

interface RpcAttack {
  args: (s: Seed) => Record<string, unknown>
  /** 応答そのものに置く条件（目印の不在は全 RPC 共通で別に見る） */
  assert?: (data: unknown, error: { message: string } | null) => string | null
  note?: string
}

const ATTACKS: Record<string, RpcAttack> = {
  // --- 認可述語（施設 A を渡して false が返らなければ、そこから全部崩れる） ---
  is_facility_member: {
    args: (s) => ({ p_facility_id: s.facilityA.id }),
    assert: (data) => (data === false ? null : `施設 A のメンバー判定が ${JSON.stringify(data)} になった`),
  },
  is_facility_writer: {
    args: (s) => ({ p_facility_id: s.facilityA.id }),
    assert: (data) => (data === false ? null : `施設 A の書き手判定が ${JSON.stringify(data)} になった`),
  },
  is_admin: {
    args: () => ({}),
    assert: (data) => (data === false ? null : `admin 判定が ${JSON.stringify(data)} になった`),
  },
  has_aal2: { args: () => ({}), note: '自分のセッションの状態を返すだけ。他人の状態は返らない' },
  get_admin_status: { args: () => ({}), note: '自分が admin かどうかだけを返す' },

  // --- 読み取り（施設 A の中身が出てはいけない） ---
  get_distributor_product_price_history: {
    args: (s) => ({ p_distributor_product_id: s.distributorProductId }),
    note: '施設 A の仕切値と施設名が出ないこと（資産 A-02）',
  },
  get_news_feed: { args: (s) => ({ p_facility_id: s.facilityA.id, p_limit: 20, p_offset: 0 }) },
  get_order_amount_report: {
    args: () => ({ p_date_from: null, p_date_to: null }),
    note: 'admin かつ aal2 でなければ拒否される。金額が返ってはいけない',
  },
  loan_outstanding_count: {
    args: (s) => ({ p_facility_id: s.facilityA.id }),
    assert: (data) => (data === 0 ? null : `施設 A の未返却数が ${JSON.stringify(data)} と返った`),
  },
  resolve_jan_unit_price: {
    args: (s) => ({ p_jan: s.jan, p_facility_id: s.facilityA.id }),
    assert: (data) => (data === null ? null : `施設 A の単価が ${JSON.stringify(data)} と返った`),
    note: 'JAN から施設 A の仕切値を引ける経路。null 以外が返れば価格の漏洩',
  },
  resolve_denial_anomaly_subject: {
    args: () => ({ p_object_name: `sweep-${randomUUID()}` }),
    note: '拒否の急増を検知する夜間処理の裏方。施設に属さない文字列を返すだけ',
  },

  // --- 作成（施設 A に行を作れてはいけない。行が増えないことは不変条件 (2) が見る） ---
  create_case_order_atomic: {
    args: (s) => ({
      p_facility_id: s.facilityA.id, p_case_datetime: new Date().toISOString(),
      p_procedure_name: 'RPC 掃き攻撃', p_patient_id: 'RPC-ATTACK-0000', p_patient_initials: '攻撃',
      p_gender: 'other', p_doctor_name: '攻撃医師', p_items: [],
    }),
    assert: (_data, error) => (error ? null : '施設 A の症例発注が拒否されなかった'),
  },
  create_consumable_order_atomic: {
    args: (s) => ({ p_facility_id: s.facilityA.id, p_items: [] }),
    assert: (_data, error) => (error ? null : '施設 A の消耗品発注が拒否されなかった'),
  },
  create_loan_order_atomic: {
    args: (s) => ({
      p_facility_id: s.facilityA.id, p_procedure_name: 'RPC 掃き攻撃', p_maker: '攻撃メーカー', p_items: [],
    }),
    assert: (_data, error) => (error ? null : '施設 A の短貸発注が拒否されなかった'),
  },
  create_loan_return_atomic: {
    args: (s) => ({
      p_header: { facility_id: s.facilityA.id, return_datetime: new Date().toISOString() }, p_items: [],
    }),
    assert: (_data, error) => (error ? null : '施設 A の返却が拒否されなかった'),
  },
}

/**
 * **未ログイン（anon）でも呼べてよい RPC と、その理由。**
 *
 * WHY(2026-09-11・E-074): 上の掃きは未ログインでも全 RPC を叩くが、見ているのは
 *      「施設 A の目印が出ないか」だけで、**呼べること自体は許していた**。
 *      そのため `get_distributor_product_price_history` が未ログインで呼べ、
 *      施設に属さないマスタ（全代理店商品の仕切値の変更履歴）を返していたのに緑のままだった。
 *      施設の目印が出ないのは当たり前で、**マスタは施設に属さない**からである。
 *      「誰にも見せない」ではなく「**未ログインには見せない**」を測る列がここに要る。
 *
 * 判定は実測（権限で弾かれたか）で、宣言との突合は**両方向**。
 * 呼べるのに宣言が無ければ落ち、宣言にあるのに呼べなければ（＝締めたのに行が残っていれば）落ちる。
 */
const ANON_CALLABLE: Record<string, string> = {
  // 認可述語の 4 本。**どれも「あなたは誰か」を返すだけで、施設の中身は返さない**。
  // 未ログインでは false が返ることを下の掃きが毎回実測する（宣言に載せた RPC は
  // 未ログインでも assert を当てる）。RLS ポリシーの中から呼ばれるので、
  // anon から EXECUTE を外すとポリシーの評価が壊れうる——実害が無い側を残す判断。
  is_facility_member: '施設の会員かを返すだけ。未ログインでは false（実測）',
  is_facility_writer: '施設の書き手かを返すだけ。未ログインでは false（実測）',
  is_admin: 'admin かを返すだけ。未ログインでは false（実測）',
  has_aal2: '自分のセッションが aal2 かを返すだけ。他人の状態は返らない',
}

/** 施設 A の行が変わっていないことを見る対象 */
const SCOPED_TABLES = ['case_orders', 'consumable_orders', 'loan_orders', 'loan_returns', 'consumables', 'hospital_prices']

let seed: Seed
let service: SupabaseClient
let anon: SupabaseClient

async function snapshotFacilityA(): Promise<Record<string, string>> {
  const snap: Record<string, string> = {}
  for (const table of SCOPED_TABLES) {
    const { data, error } = await service.from(table).select('*').eq('facility_id', seed.facilityA.id).order('id')
    if (error) throw new Error(`[rpc-sweep] ${table} の snapshot 失敗: ${error.message}`)
    snap[table] = JSON.stringify(data)
  }
  return snap
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-019 公開 RPC を直接呼ばれても施設境界
describe('クライアントから呼べる RPC の総当たり（他施設・未ログイン） [P-019]', () => {
  beforeAll(async () => {
    service = createServiceRoleClient()
    anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const runId = randomUUID()
    const facilityA = await createFacility(service, `テスト施設A-${runId}`)
    const facilityB = await createFacility(service, `テスト施設B-${runId}`)
    const userA = await createSeededUser(service, 'rpc-sweep-user-a', facilityA.id)
    const userB = await createSeededUser(service, 'rpc-sweep-user-b', facilityB.id)

    const insertOne = async (table: string, row: Record<string, unknown>): Promise<string> => {
      const { data, error } = await service.from(table).insert(row).select('id').single()
      if (error || !data) throw new Error(`[rpc-sweep] ${table} のシード失敗: ${error?.message}`)
      return String((data as { id: unknown }).id)
    }

    const jan = `rpc-sweep-jan-${runId}`
    const productId = await insertOne('products', { jan, ref: `rpc-sweep-ref-${runId}`, name: `掃き用製品-${runId}` })
    const categoryId = await insertOne('categories', { name: `掃き用カテゴリ-${runId}` })
    const distributorProductId = await insertOne('distributor_products', {
      product_id: productId, category_id: categoryId, maker: `掃き用メーカー-${runId}`,
      supplier: `掃き用卸-${runId}`, name: `掃き用代理店商品-${runId}`, quantity: 1,
    })

    // 施設 A の中身（漏れたら分かる目印）
    const patientId = `RPC-SWEEP-PATIENT-${runId}`
    const procedureName = `RPC掃き用術式-${runId}`
    const purchasePrice = 8642097
    await insertOne('case_orders', {
      facility_id: facilityA.id, case_datetime: new Date().toISOString(), procedure_name: procedureName,
      patient_id: patientId, patient_initials: '掃き', gender: 'other', doctor_name: '掃き医師',
    })
    // WHY(status を明示する): `loan_outstanding_count` は **submitted の発注だけ**を数える。
    //      既定の状態のまま入れると自施設でも 0 が返り、「0 だった」に意味が無くなる
    //      （2026-09-09 に対照がそれを捕まえた）
    const loanOrderId = await insertOne('loan_orders', {
      facility_id: facilityA.id, procedure_name: procedureName, maker: '掃き用メーカー', status: 'submitted',
    })
    await insertOne('loan_order_items', { loan_order_id: loanOrderId, jan, name: '掃き用品目', quantity: 3 })
    const hospitalPriceId = await insertOne('hospital_prices', {
      distributor_product_id: distributorProductId, facility_id: facilityA.id,
      purchase_price: 1234, delivery_price: 1,
    })
    // WHY(作るだけでなく変える): 価格履歴は**値が変わったときだけ** 1 行残る（I-041）。
    //      履歴が無いと `get_distributor_product_price_history` は空を返し、
    //      「漏れなかった」ではなく「餌が無かった」で通ってしまう（C-021）
    const { error: reviseError } = await service
      .from('hospital_prices').update({ purchase_price: purchasePrice }).eq('id', hospitalPriceId)
    if (reviseError) throw new Error(`[rpc-sweep] 価格改定のシード失敗: ${reviseError.message}`)
    const { count: historyCount } = await service
      .from('price_histories')
      .select('*', { count: 'exact', head: true })
      .eq('entity_id', hospitalPriceId)
    if ((historyCount ?? 0) === 0) {
      throw new Error('[rpc-sweep] 価格履歴が 1 行も生まれていない（価格履歴の RPC を空振りで測ることになる）')
    }

    seed = {
      facilityA, facilityB, userA, userB, jan, distributorProductId,
      productId, categoryId, patientId, procedureName, purchasePrice,
    }
  }, 60_000)

  afterAll(async () => {
    if (!seed) return
    await cleanupFacilitiesAndUsers(seed.userA, seed.userB, seed.facilityA, seed.facilityB)
    // WHY(マスタも消す、2026-09-09): 施設を消しても製品・カテゴリ・代理店商品は残る
    //      （施設に紐づかないため）。ここが抜けていて、緑の実行のたびに 3 行ずつ積んでいた。
    //      仕切値の履歴は親の削除に合わせて DB のトリガーが消す（20260910000000）。
    const service = createServiceRoleClient()
    await deleteWhereIn(service, 'distributor_products', 'id', [seed.distributorProductId])
    await deleteWhereIn(service, 'products', 'id', [seed.productId])
    await deleteWhereIn(service, 'categories', 'id', [seed.categoryId])
  }, 60_000)

  it('公開されている RPC はすべて攻撃表にある（新しく公開したら決めさせる）', () => {
    const exposed = exposedRpcNames()
    const missing = exposed.filter((n) => !(n in ATTACKS))
    expect(missing, 'RPC_ATTACKS に足す（他施設・未ログインで呼んだときの期待を決める）').toEqual([])
    const stale = Object.keys(ATTACKS).filter((n) => !exposed.includes(n))
    expect(stale, '公開されていない RPC が攻撃表に残っている').toEqual([])
    // fail-open 防止（2026-09-09 実測: 15 本）
    expect(exposed.length, 'RPC を列挙できていない').toBeGreaterThanOrEqual(15)
  })

  it('他施設の利用者・未ログインが全 RPC を呼んでも、施設 A の中身は出ず・行は変わらない', async () => {
    const markers = [seed.patientId, seed.procedureName, String(seed.purchasePrice), seed.facilityA.name]
    const before = await snapshotFacilityA()
    const leaks: string[] = []
    const unreached: string[] = []
    const anonCallable: string[] = []

    for (const [name, attack] of Object.entries(ATTACKS)) {
      for (const [who, client] of [['施設 B', seed.userB.client], ['未ログイン', anon]] as const) {
        const { data, error } = await client.rpc(name, attack.args(seed))

        // 空振り防止: 引数の形が合わないと PostgREST は PGRST202 を返す。届いていないので落とす
        if (error && /PGRST202|Could not find the function/i.test(error.message)) {
          unreached.push(`${name}（${who}）: 引数の形が合わず関数に届いていない（${error.message}）`)
          continue
        }

        // WHY(2026-09-11・E-074): 未ログインで**通ってしまったかどうか**を集める。
        //      42501 は 2 通りある——関数の EXECUTE が無い場合と、関数の中で読む表の権限が
        //      無い場合（`get_news_feed` は SECURITY INVOKER なので後者になる）。
        //      **どちらも未ログインでは使えない**ので、ここでは区別せず「使えない」に倒す。
        //      逆に、関数の中で認可の判定に引っかかって例外になった場合（P0001 等）は
        //      **通っている**——止めているのは権限ではなく関数の中の 1 行だけなので、
        //      呼べた側に数えて宣言させる。
        if (who === '未ログイン') {
          const denied =
            (error as { code?: string } | null)?.code === '42501' ||
            /permission denied/i.test(error?.message ?? '')
          if (!denied) anonCallable.push(name)
        }

        const body = JSON.stringify(data ?? null)
        const hit = markers.filter((m) => body.includes(m))
        if (hit.length > 0) leaks.push(`${name}（${who}）: 施設 A の目印が応答に出た（${hit.join(', ')}）`)

        // 他施設の利用者としての期待。
        // WHY(2026-09-11): **未ログインでも呼べると宣言した RPC には、未ログインでも当てる**。
        //      「呼べてよい」と決めたなら、呼べたときに何が返るかまで測らないと
        //      宣言が「開けっ放しの言い訳」になる（ANON_CALLABLE の理由が実測に裏打ちされる）。
        //      それ以外の RPC は権限で落ちるのが普通なので、目印だけを見る
        const appliesAssert = who === '施設 B' || name in ANON_CALLABLE
        if (appliesAssert && attack.assert) {
          const message = attack.assert(data, error)
          if (message) leaks.push(`${name}（${who}）: ${message}`)
        }
      }
    }

    const after = await snapshotFacilityA()
    const changed = Object.keys(before).filter((t) => before[t] !== after[t])

    expect(unreached, '引数の形が合わず一度も届いていない RPC がある（見かけだけの攻撃）').toEqual([])
    expect(leaks, 'RPC 経由で施設 A の中身が出た').toEqual([])
    expect(changed, 'RPC 経由で施設 A の行が変わった').toEqual([])

    // 未ログインで呼べる RPC は宣言と一致していること（両方向）
    const undeclared = anonCallable.filter((n) => !(n in ANON_CALLABLE))
    expect(
      undeclared,
      '未ログインで呼べる RPC が ANON_CALLABLE に無い（開けてよいなら理由を書く。よくないなら REVOKE する）'
    ).toEqual([])
    const stale = Object.keys(ANON_CALLABLE).filter((n) => !anonCallable.includes(n))
    expect(stale, 'ANON_CALLABLE にあるが実際は未ログインで呼べない（宣言が実態より広い）').toEqual([])
  }, 60_000)

  it('対照: 施設 A の利用者が同じ RPC を呼ぶと、自施設の値が返る（拒否が「全部拒否」ではない）', async () => {
    // WHY(C-021): 「出なかった」は境界が効いている場合と、そもそも誰にも返らない場合の両方で成り立つ。
    //      同じ呼び出しが自施設で通ることを見て初めて、上の「出なかった」に意味が出る。
    const member = await seed.userA.client.rpc('is_facility_member', { p_facility_id: seed.facilityA.id })
    expect(member.error).toBeNull()
    expect(member.data, '施設 A の利用者のメンバー判定が true にならない').toBe(true)

    const outstanding = await seed.userA.client.rpc('loan_outstanding_count', { p_facility_id: seed.facilityA.id })
    expect(outstanding.error).toBeNull()
    expect(outstanding.data, '施設 A の未返却数が 0 のままで、上の「0 だった」に意味が無い').toBeGreaterThan(0)

    const price = await seed.userA.client.rpc('resolve_jan_unit_price', {
      p_jan: seed.jan, p_facility_id: seed.facilityA.id,
    })
    expect(price.error).toBeNull()
    expect(price.data, '施設 A の利用者にも単価が返らない（上の null に意味が無い）').toBe(seed.purchasePrice)
  }, 60_000)
})
