// e2e/api-cross-facility-attack.spec.ts
// WHY: 約束カタログ P-017（issue #757 の 1）。これまで test-matrix の「直接攻撃の実測（テスト外）」は
//      人が他施設ユーザーで API を叩く手動作業だった。ここでは src/app 配下の route.ts を機械的に
//      列挙し、施設 B のユーザーが施設 A の ID を query / body / path に入れて全メソッドを叩く。
//      期待ステータスを route ごとに手書きせず、2 つの不変条件で判定する:
//        (1) 応答が 2xx なら、本文に施設 A の目印（施設 A の ID・シードした発注 ID・術式名）が無い
//        (2) 全攻撃の前後で、施設 A の行（発注 3 種・返却・消耗品・仕入価格・施設・所属）が 1 つも変わらない
//      新しい route × メソッドが増えると攻撃表（api-attack-matrix.ts）に無いため失敗する（ratchet）。
//      表に書いてあって実在しない route も失敗する（表の腐敗検知）。
//
// 前提: global-setup.ts が cross-facility フィクスチャ（施設 A / B、ユーザー A / B、施設 A の短貸発注）
//      を作っていること。無ければ skip。
// 前提2: この spec は「攻撃の間、施設 A に他の誰も書き込まない」ことを前提に前後スナップショットを
//      比較する。施設 A は他の spec（consumable-orders.spec.ts）も書き込む共有フィクスチャなので、
//      並列実行のままだと他テストの行が「攻撃で変わった」と誤検知される（2026-09-07 実測）。
//      playwright.config.ts で単独プロジェクトに隔離して先頭に走らせることで前提を守っている
//      （e2e/project-isolation.ts）。この spec を別プロジェクトから外すとフレーキーが再発する。

import { test, expect, request as playwrightRequest, type APIRequestContext } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import * as path from 'path'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'
import {
  ATTACK_MATRIX,
  FACILITY_A,
  LOAN_ORDER_A,
  PRODUCT_A,
  SECOND_PRODUCT_A,
  CATEGORY_A,
  DISTRIBUTOR_PRODUCT_A,
  RANDOM_UUID,
  type AttackCase,
  type PathId,
} from './api-attack-matrix'
// WHY(2026-09-10): route の列挙と攻撃表との突合は `api-route-registry.ts` にしか置かない。
//      突合の合否は **`npm test`（vitest）が毎回**判定する
//      （`src/__tests__/api-attack-matrix-ratchet.test.ts`）。
//      ここに合否を置くと、E2E が節目実行であることと、下の `test.skip`
//      （フィクスチャ / SUPABASE_SERVICE_ROLE_KEY）に巻き込まれて、
//      **ファイルを読むだけで済む検査が Supabase の有無で黙ってスキップされる**（実際そうなっていた）。
import { discoverRoutes } from './api-route-registry'

const FACILITY_SCOPED_TABLES = ['loan_orders', 'case_orders', 'consumable_orders', 'loan_returns', 'consumables', 'hospital_prices', 'user_facilities']
// WHY(マスタも「変わらない」に入れる、2026-09-09): 攻撃が実在するマスタの行を狙うようになり、
//      PUT / DELETE が通ってしまえば施設の外側（全施設が使う商品・カテゴリ・互換）が壊れる。
//      施設で絞れないので表ごと全行を比べる。攻撃 spec は隔離プロジェクトで単独実行なので、
//      この間に他の spec がマスタへ書き込むことはない（e2e/project-isolation.ts）
const MASTER_TABLES = ['products', 'categories', 'distributor_products', 'product_compatibilities', 'price_histories']

interface Fx {
  facilityAId: string
  loanOrderId: string
  loanReturnId: string
  loanReturnItemId: string
  consumableId: string
  distributorProductId: string
  hospitalPriceId: string
  productId: string
  secondProductId: string
  categoryId: string
  compatibilityId: string
}

function substitute<T>(value: T, fx: Fx): T {
  const json = JSON.stringify(value)
    .replaceAll(FACILITY_A, fx.facilityAId)
    .replaceAll(LOAN_ORDER_A, fx.loanOrderId)
    .replaceAll(PRODUCT_A, fx.productId)
    .replaceAll(SECOND_PRODUCT_A, fx.secondProductId)
    .replaceAll(CATEGORY_A, fx.categoryId)
    .replaceAll(DISTRIBUTOR_PRODUCT_A, fx.distributorProductId)
    .replaceAll(RANDOM_UUID, randomUUID())
  return JSON.parse(json) as T
}

/**
 * その攻撃が**認可の判定に到達しなかった**かを、実際の応答から判定する。
 *
 * WHY(2026-09-09): `weak` は今まで人が書く印でしかなく、body や route が変わっても
 *      更新されなかった。実測と突き合わせれば、印だけ足して逃げることも、
 *      到達しているのに weak のまま放置することもできなくなる。
 *   - 400: 入口の検証で止まった（認可より手前）
 *   - 404 かつ pathId が 'random': 実在しない ID なので、そもそも対象の行が無い
 *     （実在する行に対する 404 は「RLS が 0 行にした」= 到達しているので weak ではない）
 */
function isWeakOutcome(status: number, pathId: PathId): boolean {
  if (status === 400) return true
  if (status === 404 && pathId === 'random') return true
  return false
}

function serviceRoleClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 施設 A の行をテーブルごとに取り、決定的な文字列にする（前後比較用）
async function snapshotFacilityA(db: SupabaseClient, facilityAId: string): Promise<Record<string, string>> {
  const snap: Record<string, string> = {}
  for (const table of FACILITY_SCOPED_TABLES) {
    // user_facilities は複合主キーで id 列が無い
    const orderKey = table === 'user_facilities' ? 'user_id' : 'id'
    const { data, error } = await db.from(table).select('*').eq('facility_id', facilityAId).order(orderKey)
    if (error) throw new Error(`[attack] ${table} の snapshot 失敗: ${error.message}`)
    snap[table] = JSON.stringify(data)
  }
  const { data: facility } = await db.from('facilities').select('*').eq('id', facilityAId).single()
  snap['facilities'] = JSON.stringify(facility)
  for (const table of MASTER_TABLES) {
    const { data, error } = await db.from(table).select('*').order('id')
    if (error) throw new Error(`[attack] ${table} の snapshot 失敗: ${error.message}`)
    snap[table] = JSON.stringify(data)
  }
  return snap
}

const fixtures = readCrossFacilityFixtures()

// 約束カタログ（docs/agents/promise-catalog.md）: P-017 API Route の直接攻撃
test.describe('他施設ユーザーによる API Route 直接攻撃の総当たり [P-017]', () => {
  test.skip(!fixtures || !fixtures.loanOrderId, 'cross-facility フィクスチャ（loanOrderId 込み）が無い')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（snapshot に必要）')

  const routes = discoverRoutes(path.join(process.cwd(), 'src', 'app'))

  // NOTE(2026-09-10): 「攻撃表と実在 route が過不足なく対応する」ratchet は
  //      `src/__tests__/api-attack-matrix-ratchet.test.ts` へ移した（`npm test` で毎回回る）。
  //      ここに置いていた間は、上の `test.skip` に巻き込まれて
  //      **Supabase を止めている間ずっとスキップされていた**。

  test('全 route × 全メソッドを施設 B のユーザーで叩いても、施設 A のデータは漏れず・変わらない', async ({ baseURL }) => {
    const fx: Fx = {
      facilityAId: fixtures!.facilityAId,
      loanOrderId: fixtures!.loanOrderId!,
      distributorProductId: fixtures!.distributorProductId!,
      loanReturnId: fixtures!.loanReturnId!,
      loanReturnItemId: fixtures!.loanReturnItemId!,
      consumableId: fixtures!.consumableId!,
      hospitalPriceId: fixtures!.facilityAHospitalPriceId!,
      productId: fixtures!.productId!,
      secondProductId: fixtures!.secondProductId!,
      categoryId: fixtures!.categoryId!,
      compatibilityId: fixtures!.compatibilityId!,
    }
    for (const [name, value] of Object.entries(fx)) {
      expect(value, `フィクスチャの ${name} が無い（攻撃が実在しない ID を叩いて空振りする）`).toBeTruthy()
    }
    // WHY(価格と施設名も目印にする、2026-09-09): 価格履歴の route は施設スコープの行を
    //      SECURITY DEFINER の RPC 内の手書き WHERE で絞る。漏れるとしたら
    //      **施設 A の仕切値そのものと施設名**なので、それを目印に加える（資産 A-02）。
    const markers = [
      fx.facilityAId,
      fx.loanOrderId,
      fixtures!.loanOrderProcedureName,
      String(fixtures!.facilityAPurchasePrice),
      fixtures!.facilityAName!,
      // 消耗品の品名も施設の運用が見える情報（2026-09-09）
      fixtures!.consumableName!,
    ]
    const db = serviceRoleClient()
    const before = await snapshotFacilityA(db, fx.facilityAId)

    const ctx: APIRequestContext = await playwrightRequest.newContext({
      baseURL,
      storageState: CROSS_FACILITY_USER_B_AUTH_PATH,
      extraHTTPHeaders: { 'content-type': 'application/json' },
    })
    const leaks: string[] = []
    const log: string[] = []
    const staleWeak: string[] = []
    const unreached: string[] = []
    try {
      for (const { route, methods } of routes) {
        for (const m of methods) {
          const spec = ATTACK_MATRIX[route]?.[m]
          if (spec && 'skip' in spec) { log.push(`${m} ${route}: skip（${spec.skip}）`); continue }
          const c: AttackCase = substitute(spec ?? {}, fx)
          const idFor: Record<PathId, string> = {
            facilityA: fx.facilityAId,
            loanOrderA: fx.loanOrderId,
            loanReturnA: fx.loanReturnId,
            loanReturnItemA: fx.loanReturnItemId,
            consumableA: fx.consumableId,
            distributorProductA: fx.distributorProductId,
            hospitalPriceA: fx.hospitalPriceId,
            productA: fx.productId,
            categoryA: fx.categoryId,
            compatA: fx.compatibilityId,
            random: randomUUID(),
          }
          const pathId: PathId = c.pathId ?? 'random'
          // WHY(2 つ目の動的部分、2026-09-09): `/api/loan-returns/[id]/items/[itemId]` のように
          //      動的部分が 2 つある route がある。`[itemId]` を置き換え忘れると
          //      URL に文字列がそのまま残り、認可まで届かない（weak として落ちる）
          const url = route
            .replace('[id]', idFor[pathId])
            .replace('[itemId]', idFor[c.itemPathId ?? 'random'])
          const query = new URLSearchParams(c.query ?? { facility_id: fx.facilityAId, facilityId: fx.facilityAId })
          const res = await ctx.fetch(`${url}?${query.toString()}`, {
            method: m,
            data: c.body === undefined ? undefined : JSON.stringify(c.body),
          })
          const text = await res.text()
          const status = res.status()
          // proxy.ts の admin ガードは非 admin を /login へリダイレクトする。request は追従するので
          // 最終 URL が /login なら「拒否された」と読む（200 でも admin データは返っていない）
          const finalPath = new URL(res.url()).pathname
          const redirected = finalPath !== url ? ` → ${finalPath}` : ''
          log.push(`${m} ${url}: ${status}${redirected}${c.weak ? '（weak）' : ''}${process.env.ATTACK_LOG === '2' ? ` ${text.slice(0, 200).replace(/\s+/g, ' ')}` : ''}`)
          // 不変条件 (1): 2xx で施設 A の目印が本文に含まれれば漏洩
          if (status >= 200 && status < 300) {
            // 施設 A の ID 自体はマスタ参照（/api/facilities/[id]、my-role）で正当に返るため、
            // 発注 ID と術式名を目印にする。施設 A の ID は施設スコープの一覧 route でのみ目印に含める
            const idIsMarker = !/^\/api\/facilities/.test(route)
            const hit = markers.filter(mk => (mk !== fx.facilityAId || idIsMarker) && text.includes(mk))
            if (hit.length > 0) leaks.push(`${m} ${url}: 2xx で施設 A の目印を含む（${hit.join(', ')}）`)
          }
          // 不変条件 (3): weak の印は実測と一致する（宣言と実態の両方向の突合）
          const weakInFact = isWeakOutcome(status, pathId)
          if (c.weak && !weakInFact) {
            staleWeak.push(`${m} ${route}: weak と書いてあるが ${status} で認可まで届いている。印を外す`)
          }
          if (!c.weak && weakInFact) {
            unreached.push(
              `${m} ${route}: ${status} で止まり認可まで届いていない` +
                `（${status === 400 ? '入口の検証。body を通る形にする' : '実在しない ID。pathId をフィクスチャの行に向ける'}）`
            )
          }
        }
      }
    } finally {
      await ctx.dispose()
    }
    // 不変条件 (2): 施設 A の行が変わっていない
    const after = await snapshotFacilityA(db, fx.facilityAId)
    const changed = Object.keys(before).filter(t => before[t] !== after[t])

    test.info().annotations.push({ type: 'attack-log', description: log.join('\n') })
    if (leaks.length > 0 || changed.length > 0 || process.env.ATTACK_LOG) {
      console.log(['[attack-log]', ...log].join('\n'))
    }
    expect(leaks, '他施設ユーザーへ施設 A のデータが漏れた').toEqual([])
    expect(changed, '他施設ユーザーの攻撃で施設 A の行・マスタの行が変わった').toEqual([])
    expect(staleWeak, '攻撃表の weak が実態と合っていない（届いているのに weak のまま）').toEqual([])
    expect(unreached, '認可まで届いていない攻撃がある（見かけだけの攻撃）').toEqual([])
    expect(log.length, '攻撃が 1 件も実行されていない（列挙の自壊）').toBeGreaterThan(10)
  })
})
