// e2e/generate-cross-facility-auth-state.ts
// WHY: issue #321（issue #315の後半として切り出し）。
//      施設Bのユーザーが施設Aの発注データをUI上で閲覧できないことを検証するには、
//      2ユーザー×2施設の認証済みPlaywright storageStateが必要。既存の
//      generate-auth-state.tsは固定の単一テストユーザー用のため、こちらは
//      supabase/__tests__/integration/helpers/seed-rls-idor.tsと同様の方式で
//      施設A・施設B、それぞれに所属するユーザーA・ユーザーBを都度作成し、
//      施設Aにloan_orders 1件をシードする。

import { createClient } from '@supabase/supabase-js'
import { loadEnvConfig } from '@next/env'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { assertTestSupabaseEnv } from './env-guard'
import { signInAndSaveStorageState } from './generate-auth-state'

;(process.env as Record<string, string>).NODE_ENV = 'test'
loadEnvConfig(process.cwd())
assertTestSupabaseEnv()

export interface CrossFacilityFixtures {
  facilityAId: string
  facilityBId: string
  loanOrderProcedureName: string
}

export const CROSS_FACILITY_FIXTURES_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-fixtures.json')
export const CROSS_FACILITY_USER_A_AUTH_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-user-a.json')
export const CROSS_FACILITY_USER_B_AUTH_PATH = path.join(process.cwd(), 'e2e', '.auth', 'cross-facility-user-b.json')

/** cross-facility-boundary.spec.ts から読む。フィクスチャが無ければnull（specはskipする）。 */
export function readCrossFacilityFixtures(): CrossFacilityFixtures | null {
  if (!fs.existsSync(CROSS_FACILITY_FIXTURES_PATH)) return null
  return JSON.parse(fs.readFileSync(CROSS_FACILITY_FIXTURES_PATH, 'utf-8')) as CrossFacilityFixtures
}

export async function generateCrossFacilityAuthState(): Promise<void> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  fs.mkdirSync(path.dirname(CROSS_FACILITY_FIXTURES_PATH), { recursive: true })

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn(
      '[E2E cross-facility auth] SUPABASE_SERVICE_ROLE_KEY 等が未設定。' +
        'cross-facility-boundary.spec.ts はフィクスチャ不在としてskipされます。'
    )
    return
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const runId = randomUUID()

  const { data: facilityA, error: facilityAError } = await supabase
    .from('facilities')
    .insert({ name: `テスト施設A-${runId}` })
    .select('id')
    .single()
  if (facilityAError || !facilityA) {
    throw new Error(`[E2E cross-facility auth] 施設A作成失敗: ${facilityAError?.message}`)
  }

  const { data: facilityB, error: facilityBError } = await supabase
    .from('facilities')
    .insert({ name: `テスト施設B-${runId}` })
    .select('id')
    .single()
  if (facilityBError || !facilityB) {
    throw new Error(`[E2E cross-facility auth] 施設B作成失敗: ${facilityBError?.message}`)
  }

  const emailA = `e2e-cross-facility-user-a-${runId}@example.test`
  const emailB = `e2e-cross-facility-user-b-${runId}@example.test`

  const { data: userAData, error: userAError } = await supabase.auth.admin.createUser({
    email: emailA,
    email_confirm: true,
  })
  if (userAError || !userAData.user) {
    throw new Error(`[E2E cross-facility auth] ユーザーA作成失敗: ${userAError?.message}`)
  }

  const { data: userBData, error: userBError } = await supabase.auth.admin.createUser({
    email: emailB,
    email_confirm: true,
  })
  if (userBError || !userBData.user) {
    throw new Error(`[E2E cross-facility auth] ユーザーB作成失敗: ${userBError?.message}`)
  }

  const { error: linkAError } = await supabase
    .from('user_facilities')
    .insert({ user_id: userAData.user.id, facility_id: facilityA.id, role: 'staff' })
  if (linkAError) {
    throw new Error(`[E2E cross-facility auth] ユーザーAの施設紐付け失敗: ${linkAError.message}`)
  }

  const { error: linkBError } = await supabase
    .from('user_facilities')
    .insert({ user_id: userBData.user.id, facility_id: facilityB.id, role: 'staff' })
  if (linkBError) {
    throw new Error(`[E2E cross-facility auth] ユーザーBの施設紐付け失敗: ${linkBError.message}`)
  }

  // シード用の1件はservice role client（RLSをバイパスする）で直接作成する。
  const loanOrderProcedureName = `クロス施設境界テスト用術式-${runId}`
  const { error: loanOrderError } = await supabase
    .from('loan_orders')
    .insert({
      facility_id: facilityA.id,
      procedure_name: loanOrderProcedureName,
      maker: 'クロス施設境界テスト用メーカー',
    })
  if (loanOrderError) {
    throw new Error(`[E2E cross-facility auth] loan_ordersシード失敗: ${loanOrderError.message}`)
  }

  await signInAndSaveStorageState(supabase, emailA, CROSS_FACILITY_USER_A_AUTH_PATH)
  await signInAndSaveStorageState(supabase, emailB, CROSS_FACILITY_USER_B_AUTH_PATH)

  const fixtures: CrossFacilityFixtures = {
    facilityAId: facilityA.id as string,
    facilityBId: facilityB.id as string,
    loanOrderProcedureName,
  }
  fs.writeFileSync(CROSS_FACILITY_FIXTURES_PATH, JSON.stringify(fixtures))
  console.log(`[E2E cross-facility auth] フィクスチャを書き出しました: ${CROSS_FACILITY_FIXTURES_PATH}`)
}

const isMainModule = process.argv[1]?.endsWith('generate-cross-facility-auth-state.ts')
if (isMainModule) {
  generateCrossFacilityAuthState().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
