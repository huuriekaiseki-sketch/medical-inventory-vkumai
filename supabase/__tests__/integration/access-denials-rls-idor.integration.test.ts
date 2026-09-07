// supabase/__tests__/integration/access-denials-rls-idor.integration.test.ts
// WHY: issue #757 の 24（拒否された操作の記録、P-063）。
//      「拒否そのもの」は既存の RLS / ガードが守るので、ここで確かめるのは証跡の性質:
//        - 記録できるのは service_role だけ（client ロールは偽の記録を作れない）
//        - 読めるのは aal2 まで上げた admin だけ
//        - 消せない・書き換えられない（service_role でも）
//        - アプリの記録ヘルパー（recordAccessDenial）が実際に 1 行残す
//        - 記録に失敗してもヘルパーは例外を投げない（拒否を止めない）

import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  cleanupFacilitiesAndUsers,
  createFacility,
  createSeededUser,
  createServiceRoleClient,
  type SeededUser,
} from './helpers/seed-rls-idor'
import { recordAccessDenial } from '@/lib/security/access-denial'

const UNAUTHORIZED = '42501'

function createAnonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-063 拒否された操作は append-only に残り admin だけが読める
describe('拒否された操作の記録（access_denials） [P-063]', () => {
  const serviceClient = createServiceRoleClient()
  let facilityA: { id: string; name: string }
  let facilityB: { id: string; name: string }
  let staff: SeededUser
  let other: SeededUser
  let admin: SeededUser
  const marker = randomUUID()

  beforeAll(async () => {
    facilityA = await createFacility(serviceClient, `拒否記録-A-${marker}`)
    facilityB = await createFacility(serviceClient, `拒否記録-B-${marker}`)
    staff = await createSeededUser(serviceClient, 'denial-staff', facilityA.id)
    other = await createSeededUser(serviceClient, 'denial-other', facilityB.id)
    admin = await createSeededUser(serviceClient, 'denial-admin', facilityA.id, 'admin')
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(admin.id)
    await cleanupFacilitiesAndUsers(staff, other, facilityA, facilityB)
  })

  it('アプリのヘルパーが呼ばれると 1 行残り、誰が・どの境界で・どの理由かが入る', async () => {
    await recordAccessDenial({
      guard: 'facility',
      reason: 'forbidden',
      actorId: other.id,
      facilityId: facilityA.id,
      route: `/api/case-orders?facility_id=${facilityA.id}`,
      method: 'GET',
    })

    const { data, error } = await serviceClient
      .from('access_denials')
      .select('guard, reason, actor_id, facility_id, route, method')
      .eq('actor_id', other.id)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].guard).toBe('facility')
    expect(data![0].reason).toBe('forbidden')
    expect(data![0].facility_id).toBe(facilityA.id)
    expect(data![0].method).toBe('GET')
    // WHY: route はクエリ文字列を落として保存する（施設 ID や検索語が証跡に残らないように。#757-5）
    expect(data![0].route).toBe('/api/case-orders')
  })

  it('client ロールは記録を作れない（record_access_denial の EXECUTE を持たない）', async () => {
    const viaStaff = await staff.client.rpc('record_access_denial', {
      p_guard: 'facility',
      p_reason: 'forbidden',
      p_route: '/api/fake',
      p_method: 'GET',
      p_actor_id: staff.id,
      p_facility_id: facilityA.id,
    })
    expect(viaStaff.error).not.toBeNull()
    expect(viaStaff.error!.code).toBe(UNAUTHORIZED)

    const viaAnon = await createAnonClient().rpc('record_access_denial', {
      p_guard: 'auth',
      p_reason: 'unauthenticated',
      p_route: '/api/fake',
      p_method: 'GET',
      p_actor_id: null,
      p_facility_id: null,
    })
    expect(viaAnon.error).not.toBeNull()

    // 直接 INSERT も通らない（GRANT が SELECT だけ）
    const direct = await staff.client.from('access_denials').insert({ guard: 'auth', reason: 'unauthenticated' })
    expect(direct.error).not.toBeNull()
  })

  it('client は読めない。admin も aal2 でなければ読めない（MFA 未登録の admin は読める）', async () => {
    const asStaff = await staff.client.from('access_denials').select('id')
    expect(asStaff.error).toBeNull()
    expect(asStaff.data ?? []).toHaveLength(0)

    // WHY: このテストの admin は TOTP を登録していないので has_aal2() は TRUE を返す（#623 の設計）。
    //      MFA 登録済み・aal1 で読めないことは blast-radius.integration.test.ts が測る
    const asAdmin = await admin.client.from('access_denials').select('id').eq('actor_id', other.id)
    expect(asAdmin.error).toBeNull()
    expect(asAdmin.data ?? []).toHaveLength(1)

    const asAnon = await createAnonClient().from('access_denials').select('id')
    expect(asAnon.error).not.toBeNull()
  })

  it('service_role でも書き換え・削除できない（append-only）', async () => {
    const { data: before } = await serviceClient
      .from('access_denials')
      .select('id, reason')
      .eq('actor_id', other.id)
      .single()

    const update = await serviceClient.from('access_denials').update({ reason: 'not_admin' }).eq('id', before!.id)
    expect(update.error).not.toBeNull()
    const del = await serviceClient.from('access_denials').delete().eq('id', before!.id)
    expect(del.error).not.toBeNull()

    const { data: after } = await serviceClient
      .from('access_denials')
      .select('id, reason')
      .eq('id', before!.id)
      .single()
    expect(after!.reason).toBe(before!.reason)
  })

  it('知らない guard / reason は CHECK が拒否する（語彙が勝手に増えない）', async () => {
    const { error } = await serviceClient.rpc('record_access_denial', {
      p_guard: 'unknown-guard',
      p_reason: 'forbidden',
      p_route: null,
      p_method: null,
      p_actor_id: null,
      p_facility_id: null,
    })
    expect(error).not.toBeNull()
  })

  it('記録できなくてもヘルパーは例外を投げない（拒否を止めない）', async () => {
    // 不正な値でも呼び出し側には伝播しない
    await expect(
      recordAccessDenial({ guard: 'auth', reason: 'forbidden', actorId: 'not-a-uuid' })
    ).resolves.toBeUndefined()
  })
})
