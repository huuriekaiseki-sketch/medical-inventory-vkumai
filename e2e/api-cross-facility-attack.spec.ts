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
import * as fs from 'fs'
import * as path from 'path'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'
import { ATTACK_MATRIX, FACILITY_A, LOAN_ORDER_A, RANDOM_UUID, type AttackCase, type Method } from './api-attack-matrix'

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const FACILITY_SCOPED_TABLES = ['loan_orders', 'case_orders', 'consumable_orders', 'loan_returns', 'consumables', 'hospital_prices', 'user_facilities']

// src/app 配下の route.ts を列挙し、'/api/loan-orders' や '/api/hospital-prices/[id]' の形にする
function discoverRoutes(): { route: string; methods: Method[] }[] {
  const appDir = path.join(process.cwd(), 'src', 'app')
  const found: { route: string; methods: Method[] }[] = []
  const walk = (dir: string) => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name)
      if (fs.statSync(p).isDirectory()) { walk(p); continue }
      if (name !== 'route.ts') continue
      const rel = path.relative(appDir, path.dirname(p)).split(path.sep).join('/')
      const src = fs.readFileSync(p, 'utf-8')
      const methods = METHODS.filter(m => new RegExp(`export\\s+async\\s+function\\s+${m}\\b`).test(src))
      found.push({ route: `/${rel}`, methods })
    }
  }
  walk(appDir)
  return found.sort((a, b) => a.route.localeCompare(b.route))
}

function substitute<T>(value: T, fx: { facilityAId: string; loanOrderId: string }): T {
  const json = JSON.stringify(value)
    .replaceAll(FACILITY_A, fx.facilityAId)
    .replaceAll(LOAN_ORDER_A, fx.loanOrderId)
    .replaceAll(RANDOM_UUID, randomUUID())
  return JSON.parse(json) as T
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
  return snap
}

const fixtures = readCrossFacilityFixtures()

// 約束カタログ（docs/agents/promise-catalog.md）: P-017 API Route の直接攻撃
test.describe('他施設ユーザーによる API Route 直接攻撃の総当たり [P-017]', () => {
  test.skip(!fixtures || !fixtures.loanOrderId, 'cross-facility フィクスチャ（loanOrderId 込み）が無い')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（snapshot に必要）')

  const routes = discoverRoutes()

  test('攻撃表は実在する route × メソッドと過不足なく対応する（ratchet）', () => {
    const missing: string[] = []
    for (const { route, methods } of routes) {
      const entry = ATTACK_MATRIX[route]
      if (!entry) { missing.push(`${route}（表に無い）`); continue }
      for (const m of methods) {
        if (m === 'GET') continue // GET は既定の攻撃（query に施設 A）でよい
        if (!entry[m]) missing.push(`${route} ${m}（書き込み系は有効な body を表に書く）`)
      }
    }
    const stale: string[] = []
    for (const route of Object.keys(ATTACK_MATRIX)) {
      const r = routes.find(x => x.route === route)
      if (!r) { stale.push(`${route}（route.ts が無い）`); continue }
      for (const m of Object.keys(ATTACK_MATRIX[route]) as Method[]) {
        if (!r.methods.includes(m)) stale.push(`${route} ${m}（export されていない）`)
      }
    }
    expect(missing, '新しい route / メソッドを api-attack-matrix.ts に足す').toEqual([])
    expect(stale, '消えた route / メソッドを api-attack-matrix.ts から消す').toEqual([])
  })

  test('全 route × 全メソッドを施設 B のユーザーで叩いても、施設 A のデータは漏れず・変わらない', async ({ baseURL }) => {
    const fx = { facilityAId: fixtures!.facilityAId, loanOrderId: fixtures!.loanOrderId! }
    const markers = [fx.facilityAId, fx.loanOrderId, fixtures!.loanOrderProcedureName]
    const db = serviceRoleClient()
    const before = await snapshotFacilityA(db, fx.facilityAId)

    const ctx: APIRequestContext = await playwrightRequest.newContext({
      baseURL,
      storageState: CROSS_FACILITY_USER_B_AUTH_PATH,
      extraHTTPHeaders: { 'content-type': 'application/json' },
    })
    const leaks: string[] = []
    const log: string[] = []
    try {
      for (const { route, methods } of routes) {
        for (const m of methods) {
          const spec = ATTACK_MATRIX[route]?.[m]
          if (spec && 'skip' in spec) { log.push(`${m} ${route}: skip（${spec.skip}）`); continue }
          const c: AttackCase = substitute(spec ?? {}, fx)
          const idFor = { facilityA: fx.facilityAId, loanOrderA: fx.loanOrderId, random: randomUUID() }
          const url = route.replace('[id]', idFor[c.pathId ?? 'random'])
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
    expect(changed, '他施設ユーザーの攻撃で施設 A の行が変わった').toEqual([])
    expect(log.length, '攻撃が 1 件も実行されていない（列挙の自壊）').toBeGreaterThan(10)
  })
})
