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
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

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

  // WHY(2026-09-07、RLS ミューテーション RM-012 で生き残った): ここまでのテストは
  //      「staff は読めない」「anon は読めない」までで、**MFA 登録済みで aal2 に上げていない admin**
  //      を試していなかった（既存のコメントにも「MFA 登録済み・aal1 で読めないことは
  //      blast-radius が測る」と書いてあるが、blast-radius はこの表を見ていない）。
  //      そのためポリシーから `has_aal2()` を外しても 1 件も落ちなかった。
  //
  //      拒否の記録は「誰がどこで弾かれたか」の一覧なので、読み手が緩むと
  //      乗っ取り側が「自分の総当たりがどこまで見えているか」を確認できてしまう。
  describe('aal2 に上げていない admin は読めない（RM-012 を倒す）', () => {
    const PASSWORD = 'Passw0rd!aal1-denials'
    const mfaEmail = `denial-mfa-admin-${marker}@example.test`
    let mfaAdminId: string
    let factorId: string
    let secret: string

    beforeAll(async () => {
      const { data: user, error } = await serviceClient.auth.admin.createUser({
        email: mfaEmail,
        password: PASSWORD,
        email_confirm: true,
      })
      if (error || !user.user) throw new Error(`ユーザー作成失敗: ${error?.message}`)
      mfaAdminId = user.user.id
      const { error: linkError } = await serviceClient
        .from('user_facilities')
        .insert({ user_id: mfaAdminId, facility_id: facilityA.id, role: 'admin' })
      if (linkError) throw new Error(`所属作成失敗: ${linkError.message}`)

      const client = createAnonClient()
      await signInAtAal1(client, mfaEmail, PASSWORD)
      const enrolled = await enrollAndVerifyTotp(client)
      factorId = enrolled.factorId
      secret = enrolled.secret
    }, 60_000)

    afterAll(async () => {
      await serviceClient.auth.admin.deleteUser(mfaAdminId)
    })

    async function aal1() {
      const client = createAnonClient()
      await signInAtAal1(client, mfaEmail, PASSWORD)
      return client
    }

    it('aal1 の admin は 1 件も読めない', async () => {
      const client = await aal1()
      const { data, error } = await client.from('access_denials').select('id')
      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('対照: aal2 まで上げれば読める（admin の権限そのものは設計どおり）', async () => {
      // WHY(対照が要る): 表が空でも「0 件」は返る。昇格したら読めることまで見て、
      //      初めて aal2 が効いていると言える（RM-010 の教訓）
      const client = await aal1()
      await stepUpToAal2(client, factorId, secret)
      const { data, error } = await client.from('access_denials').select('id')
      expect(error).toBeNull()
      expect((data ?? []).length).toBeGreaterThan(0)
    })
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

  // WHY(W-011): Supabase Auth の管理 API は RLS のトランザクションに統合できないので、
  //      特権操作の直前に admin と aal2 を再確認して窓を狭めている（`assertAdminAal2`）。
  //      そこで弾いた拒否が**記録として残る**ことを実 DB で確かめる。
  //      語彙は 20260907040000 で `aal2_required` を足した（自由文字列にすると数えられなくなる）。
  it('aal2 で弾いた拒否を記録できる（W-011 の再確認が証跡に残る）', async () => {
    const { error } = await serviceClient.rpc('record_access_denial', {
      p_guard: 'admin',
      p_reason: 'aal2_required',
      p_route: '/api/admin/users',
      p_method: 'DELETE',
      p_actor_id: null,
      p_facility_id: null,
    })
    expect(error, `aal2_required を記録できない: ${error?.message}`).toBeNull()

    const { data } = await serviceClient
      .from('access_denials')
      .select('guard, reason, route, method')
      .eq('reason', 'aal2_required')
      .order('occurred_at', { ascending: false })
      .limit(1)
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({
      guard: 'admin',
      reason: 'aal2_required',
      route: '/api/admin/users',
      method: 'DELETE',
    })
  })
})
