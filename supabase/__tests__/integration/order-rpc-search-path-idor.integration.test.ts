// supabase/__tests__/integration/order-rpc-search-path-idor.integration.test.ts
// WHY: 20260804000001_harden_order_rpc_search_path.sqlはsearch_path=''化と
//      public.完全修飾のみを変更し、is_facility_memberによる認可チェック自体は
//      変更していない。ただしorder-repositories.integration.test.tsは自施設内での
//      成功パスしか検証しておらず、他施設IDでの拒否は未検証だった。
//      RLS/facility境界に触れる変更のため、他テナントのfacility_idを渡した場合に
//      forbiddenで拒否されることをこのテストで固定する。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'order-rpc-idor-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[order-rpc-search-path-idor] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

describe('発注作成RPC 4関数 search_path=\'\'化後のIDOR拒否確認', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()

  let ownFacilityId: string
  let otherFacilityId: string
  let userId: string
  let userClient: SupabaseClient
  let consumableIdInOtherFacility: string

  beforeAll(async () => {
    const { data: ownFacility, error: ownFacilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-自施設-${runId}` })
      .select('id')
      .single()
    if (ownFacilityError || !ownFacility) {
      throw new Error(`自施設作成失敗: ${ownFacilityError?.message}`)
    }
    ownFacilityId = ownFacility.id as string

    const { data: otherFacility, error: otherFacilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-他施設-${runId}` })
      .select('id')
      .single()
    if (otherFacilityError || !otherFacility) {
      throw new Error(`他施設作成失敗: ${otherFacilityError?.message}`)
    }
    otherFacilityId = otherFacility.id as string

    const email = `order-rpc-idor-test-${runId}@example.test`
    const { data: userData, error: userError } = await serviceClient.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (userError || !userData.user) {
      throw new Error(`ユーザー作成失敗: ${userError?.message}`)
    }
    userId = userData.user.id

    // 自施設のみ所属させ、他施設には所属させない
    const { error: linkError } = await serviceClient
      .from('user_facilities')
      .insert({ user_id: userId, facility_id: ownFacilityId, role: 'staff' })
    if (linkError) {
      throw new Error(`user_facilities作成失敗: ${linkError.message}`)
    }

    const { data: consumable, error: consumableError } = await serviceClient
      .from('consumables')
      .insert({ facility_id: otherFacilityId, name: `他施設消耗品-${runId}`, purpose: 'テスト用途' })
      .select('id')
      .single()
    if (consumableError || !consumable) {
      throw new Error(`consumables作成失敗: ${consumableError?.message}`)
    }
    consumableIdInOtherFacility = consumable.id as string

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
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(userId)
    await serviceClient.from('facilities').delete().eq('id', ownFacilityId)
    await serviceClient.from('facilities').delete().eq('id', otherFacilityId)
  })

  it('create_case_order_atomic: 他施設のfacility_idを渡すとforbiddenで拒否される', async () => {
    const { error } = await userClient.rpc('create_case_order_atomic', {
      p_facility_id: otherFacilityId,
      p_case_datetime: new Date().toISOString(),
      p_procedure_name: 'IDORテスト術式',
      p_patient_id: 'PT-IDOR',
      p_patient_initials: 'X.X.',
      p_gender: 'other',
      p_doctor_name: 'IDORテスト医師',
      p_items: [],
    })

    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })

  it('create_loan_order_atomic: 他施設のfacility_idを渡すとforbiddenで拒否される', async () => {
    const { error } = await userClient.rpc('create_loan_order_atomic', {
      p_facility_id: otherFacilityId,
      p_procedure_name: 'IDORテスト術式',
      p_maker: 'IDORテストメーカー',
      p_items: [],
    })

    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })

  it('create_consumable_order_atomic: 他施設のfacility_idを渡すとforbiddenで拒否される', async () => {
    const { error } = await userClient.rpc('create_consumable_order_atomic', {
      p_facility_id: otherFacilityId,
      p_items: [{ consumable_id: consumableIdInOtherFacility, quantity: 1 }],
    })

    expect(error).not.toBeNull()
    expect(error?.message).toContain('forbidden')
  })
})
