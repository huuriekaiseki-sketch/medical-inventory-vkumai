// supabase/__tests__/integration/custom-access-token-hook.integration.test.ts
// WHY: 20260805000002_add_custom_access_token_hook.sqlで追加したCustom Access
//      Token Hookが、実際にSupabase Authのトークン発行時に呼ばれ、user_facilities
//      のroleを集約した`user_role`クレームがJWTに正しく埋め込まれることを実DBで
//      検証する。hook関数はSECURITY DEFINERを使わずsupabase_auth_adminへの
//      明示的GRANTのみで動くため、権限設定が正しいかもここで実質的に確認する
//      (GRANT漏れがあればトークン発行自体が失敗するかclaimが欠落する)。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'custom-access-token-hook-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      '[custom-access-token-hook] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。'
    )
  }
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function decodeJwtClaims(accessToken: string): Record<string, unknown> {
  const payload = accessToken.split('.')[1]
  const json = Buffer.from(payload, 'base64url').toString('utf-8')
  return JSON.parse(json)
}

async function signUpAndAssignRole(
  serviceClient: SupabaseClient,
  facilityId: string,
  role: 'staff' | 'admin' | 'viewer' | null,
  runId: string
): Promise<SupabaseClient> {
  const roleLabel = role ?? 'none'
  const email = `custom-claim-${roleLabel}-${runId}@example.test`
  const { data: userData, error: userError } = await serviceClient.auth.admin.createUser({
    email,
    password: TEST_USER_PASSWORD,
    email_confirm: true,
  })
  if (userError || !userData.user) {
    throw new Error(`ユーザー作成失敗(${roleLabel}): ${userError?.message}`)
  }

  if (role !== null) {
    const { error: linkError } = await serviceClient
      .from('user_facilities')
      .insert({ user_id: userData.user.id, facility_id: facilityId, role })
    if (linkError) {
      throw new Error(`user_facilities作成失敗(${roleLabel}): ${linkError.message}`)
    }
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { error: signInError } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
  if (signInError) {
    throw new Error(`サインイン失敗(${roleLabel}): ${signInError.message}`)
  }
  return client
}

describe('custom_access_token_hook: JWTにuser_roleクレームが埋め込まれる', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()

  let facilityId: string
  const createdUserIds: string[] = []

  beforeAll(async () => {
    const { data: facility, error: facilityError } = await serviceClient
      .from('facilities')
      .insert({ name: `テスト施設-JWTクレーム-${runId}` })
      .select('id')
      .single()
    if (facilityError || !facility) {
      throw new Error(`施設作成失敗: ${facilityError?.message}`)
    }
    facilityId = facility.id as string
  }, 60_000)

  afterAll(async () => {
    for (const id of createdUserIds) {
      await serviceClient.auth.admin.deleteUser(id)
    }
    await serviceClient.from('facilities').delete().eq('id', facilityId)
  })

  it.each([
    ['admin', 'admin'],
    ['staff', 'staff'],
    ['viewer', 'viewer'],
  ] as const)('role=%sのユーザーはJWTのuser_roleクレームが%sになる', async (role, expected) => {
    const client = await signUpAndAssignRole(serviceClient, facilityId, role, runId)
    const { data: userResult } = await client.auth.getUser()
    createdUserIds.push(userResult.user!.id)

    const { data: sessionData } = await client.auth.getSession()
    const claims = decodeJwtClaims(sessionData.session!.access_token)

    expect(claims.user_role).toBe(expected)
  })

  it('どの施設にも所属しないユーザーはuser_roleクレームがnullになる', async () => {
    const client = await signUpAndAssignRole(serviceClient, facilityId, null, runId)
    const { data: userResult } = await client.auth.getUser()
    createdUserIds.push(userResult.user!.id)

    const { data: sessionData } = await client.auth.getSession()
    const claims = decodeJwtClaims(sessionData.session!.access_token)

    expect(claims.user_role).toBeNull()
  })
})
