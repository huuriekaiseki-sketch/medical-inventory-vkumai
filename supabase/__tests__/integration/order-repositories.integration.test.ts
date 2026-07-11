// supabase/__tests__/integration/order-repositories.integration.test.ts
// WHY: issue #287で発覚した「p_items(JSONB)にJSON.stringify済み文字列を渡すと
//      本物のPostgREST/PostgreSQLでは 'cannot extract elements from a scalar' で
//      失敗する」バグは、db.rpcをモックする既存のリポジトリテストでは検知できない。
//      本物のローカルSupabaseに接続してリポジトリ関数（createLoanOrder等）を直接
//      呼び出すことで、シリアライズ不整合の再発を防ぐ。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import { createCaseOrder } from '@/lib/case-orders/repository'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'

const TEST_USER_PASSWORD = 'order-repo-integration-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[order-repositories] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

describe('発注作成RPC 3種 (issue #287: p_itemsはJSON.stringifyせず配列のまま渡す)', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()

  let facilityId: string
  let userId: string
  let userClient: SupabaseClient
  let productJan: string
  let consumableId: string

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-発注RPC-${runId}` })
      .select('id')
      .single()
    if (facilityError || !facility) {
      throw new Error(`施設作成失敗: ${facilityError?.message}`)
    }
    facilityId = facility.id as string

    const email = `order-repo-test-${runId}@example.test`
    const { data: userData, error: userError } = await serviceClient.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (userError || !userData.user) {
      throw new Error(`ユーザー作成失敗: ${userError?.message}`)
    }
    userId = userData.user.id

    const { error: linkError } = await serviceClient
      .from('user_facilities')
      .insert({ user_id: userId, facility_id: facilityId, role: 'staff' })
    if (linkError) {
      throw new Error(`user_facilities作成失敗: ${linkError.message}`)
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
    const { error: signInError } = await userClient.auth.signInWithPassword({
      email,
      password: TEST_USER_PASSWORD,
    })
    if (signInError) {
      throw new Error(`サインイン失敗: ${signInError.message}`)
    }

    productJan = `9999999${runId.slice(0, 6)}`
    const { error: productError } = await serviceClient
      .from('products')
      .insert({ jan: productJan, ref: `REF-${runId}` })
    if (productError) {
      throw new Error(`products作成失敗: ${productError.message}`)
    }

    const { data: consumable, error: consumableError } = await serviceClient
      .from('consumables')
      .insert({ facility_id: facilityId, name: `テスト消耗品-${runId}`, purpose: 'テスト用途' })
      .select('id')
      .single()
    if (consumableError || !consumable) {
      throw new Error(`consumables作成失敗: ${consumableError?.message}`)
    }
    consumableId = consumable.id as string
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(userId)
    await serviceClient.from('facilities').delete().eq('id', facilityId)
    await serviceClient.from('products').delete().eq('jan', productJan)
  })

  it('createLoanOrder: 実DBに対して短貸発注を作成できる', async () => {
    const order = await createLoanOrder(userClient, facilityId, {
      procedureName: '統合テスト術式',
      maker: '統合テストメーカー',
      items: [{ name: '統合テスト器材', quantity: 2 }],
    })

    expect(order.facilityId).toBe(facilityId)
    expect(order.items).toHaveLength(1)
    expect(order.items[0].quantity).toBe(2)
  })

  it('createCaseOrder: 実DBに対して症例発注を作成できる', async () => {
    const order = await createCaseOrder(userClient, facilityId, {
      caseDatetime: new Date().toISOString(),
      procedureName: '統合テスト症例術式',
      patientId: 'PT-0001',
      patientInitials: 'T.T.',
      gender: 'other',
      doctorName: '統合テスト医師',
      items: [{ jan: productJan, quantity: 3 }],
    })

    expect(order.facilityId).toBe(facilityId)
    expect(order.items).toHaveLength(1)
    expect(order.items[0].quantity).toBe(3)
  })

  it('createConsumableOrder: 実DBに対して消耗品発注を作成できる', async () => {
    const order = await createConsumableOrder(userClient, facilityId, {
      items: [{ consumableId, quantity: 5 }],
    })

    expect(order.facilityId).toBe(facilityId)
    expect(order.items).toHaveLength(1)
    expect(order.items[0].quantity).toBe(5)
  })
})
