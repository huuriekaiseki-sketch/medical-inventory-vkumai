// supabase/__tests__/integration/privileged-operations-rls-idor.integration.test.ts
// WHY: issue #757 の 24・39（特権操作の記録、P-066）。
//      W-011（Supabase Auth の管理 API）は service_role でしか呼べず RLS が及ばない。
//      経路そのものを消せないので、**通った操作を後から追える**ようにするのが最後の砦になる。
//      2026-09-07 の点検では、弾かれた分だけが access_denials に残り、
//      **成功した招待・削除は 1 件も記録されていなかった**。
//
//      ここで確かめるのは証跡の性質:
//        - 成功も失敗も残る（失敗だけだと乗っ取り後に「通った」範囲が分からない）
//        - 記録できるのは service_role だけ（client ロールは偽の記録を作れない）
//        - 読めるのは aal2 まで上げた admin だけ（メールを含むため特に重要）
//        - 消せない・書き換えられない（service_role でも）
//        - 記録に失敗してもヘルパーは例外を投げない（特権操作そのものを止めない）

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
import { recordPrivilegedOperation } from '@/lib/security/privileged-operation'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

const UNAUTHORIZED = '42501'
const CHECK_VIOLATION = '23514'

function createAnonClient() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-066 特権操作は成功も失敗も append-only に残る
describe('特権操作の記録（privileged_operations） [P-066]', () => {
  const serviceClient = createServiceRoleClient()
  let facilityA: { id: string; name: string }
  let staff: SeededUser
  let admin: SeededUser
  const marker = randomUUID()
  const invitedEmail = `invited-${marker}@example.com`

  beforeAll(async () => {
    facilityA = await createFacility(serviceClient, `特権記録-${marker}`)
    staff = await createSeededUser(serviceClient, 'priv-staff', facilityA.id)
    admin = await createSeededUser(serviceClient, 'priv-admin', facilityA.id, 'admin')
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(admin.id)
    await cleanupFacilitiesAndUsers(staff, staff, facilityA, facilityA)
  })

  it('成功した招待が 1 行残り、誰が・誰を・いつが入る', async () => {
    await recordPrivilegedOperation({
      operation: 'user_invite',
      succeeded: true,
      actorId: admin.id,
      targetEmail: invitedEmail,
    })

    const { data, error } = await serviceClient
      .from('privileged_operations')
      .select('operation, succeeded, actor_id, target_email, target_user_id, error_code, occurred_at')
      .eq('actor_id', admin.id)
      .eq('operation', 'user_invite')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({
      operation: 'user_invite',
      succeeded: true,
      actor_id: admin.id,
      target_email: invitedEmail,
      target_user_id: null,
      error_code: null,
    })
    expect(data![0].occurred_at).toBeTruthy()
  })

  it('失敗した削除も残る（成功だけ残すと「試した範囲」が分からない）', async () => {
    const victim = randomUUID()
    await recordPrivilegedOperation({
      operation: 'user_delete',
      succeeded: false,
      actorId: admin.id,
      targetUserId: victim,
      errorCode: 'user_not_found',
    })

    const { data } = await serviceClient
      .from('privileged_operations')
      .select('succeeded, target_user_id, error_code')
      .eq('actor_id', admin.id)
      .eq('operation', 'user_delete')
    expect(data).toHaveLength(1)
    expect(data![0]).toMatchObject({
      succeeded: false,
      target_user_id: victim,
      error_code: 'user_not_found',
    })
  })

  it('知らない operation は CHECK が拒否する（語彙を自由文字列にしない）', async () => {
    const { error } = await serviceClient.rpc('record_privileged_operation', {
      p_operation: 'user_promote_to_god',
      p_succeeded: true,
      p_actor_id: admin.id,
    })
    expect(error?.code).toBe(CHECK_VIOLATION)
  })

  it('client（authenticated）は RPC を呼べない（偽の記録を作れない）', async () => {
    const { error } = await staff.client.rpc('record_privileged_operation', {
      p_operation: 'user_delete',
      p_succeeded: true,
      p_actor_id: staff.id,
    })
    expect(error?.code).toBe(UNAUTHORIZED)
  })

  it('anon も RPC を呼べない', async () => {
    const { error } = await createAnonClient().rpc('record_privileged_operation', {
      p_operation: 'user_invite',
      p_succeeded: true,
      p_actor_id: admin.id,
    })
    expect(error?.code).toBe(UNAUTHORIZED)
  })

  it('client は表へ直接 INSERT できない', async () => {
    const { error } = await staff.client
      .from('privileged_operations')
      .insert({ operation: 'user_delete', succeeded: true, actor_id: staff.id })
    expect(error).not.toBeNull()
  })

  it('admin でない利用者は 1 件も読めない（メールを含むため）', async () => {
    const { data, error } = await staff.client.from('privileged_operations').select('id, target_email')
    // RLS は拒否ではなく不可視（error なしで 0 件）
    expect(error).toBeNull()
    expect(data).toEqual([])
  })

  it('anon は読めない', async () => {
    const { data, error } = await createAnonClient().from('privileged_operations').select('id')
    // anon には SELECT の GRANT が無い（42501）か、RLS で 0 件のいずれか。どちらでも中身は出ない
    if (error) expect(error.code).toBe(UNAUTHORIZED)
    else expect(data).toEqual([])
  })

  it('service_role でも UPDATE できない（append-only）', async () => {
    // WHY(元の値を控える): 「どの行が取れるか」に依存しない。最初は succeeded=true を
    //      決め打ちしていて、拾った行がたまたま失敗の記録だったため落ちた。
    //      確かめたいのは「値が変わらないこと」であって、値そのものではない。
    const { data: rows } = await serviceClient
      .from('privileged_operations')
      .select('id, succeeded')
      .eq('actor_id', admin.id)
      .limit(1)
    const { id, succeeded: before } = rows![0]

    const { error } = await serviceClient
      .from('privileged_operations')
      .update({ succeeded: !before })
      .eq('id', id)
    expect(error).not.toBeNull()

    const { data: after } = await serviceClient
      .from('privileged_operations')
      .select('succeeded')
      .eq('id', id)
      .single()
    expect(after!.succeeded).toBe(before)
  })

  it('service_role でも DELETE できない（証跡を消せない）', async () => {
    const { data: before } = await serviceClient
      .from('privileged_operations')
      .select('id')
      .eq('actor_id', admin.id)

    const { error } = await serviceClient
      .from('privileged_operations')
      .delete()
      .eq('actor_id', admin.id)
    expect(error).not.toBeNull()

    const { data: after } = await serviceClient
      .from('privileged_operations')
      .select('id')
      .eq('actor_id', admin.id)
    expect(after).toHaveLength(before!.length)
  })

  // WHY(2026-09-07、RLS ミューテーション M-011 で生き残った): ここまでのテストは
  //      「admin でない利用者」「anon」しか試しておらず、**aal2 に上げていない admin** を
  //      試していなかった。そのためポリシーから `has_aal2()` を外しても 1 件も落ちず、
  //      「読み手は aal2 の admin だけ」という約束（P-066）が実質守られていなかった。
  //
  //      この表は招待先のメールを持つので、読み手の条件が緩むと PII が広がる。
  //      パスワードだけ奪われた admin（aal1）が、誰を招待し誰を消したかを一覧できてしまう。
  //
  //      `has_aal2()` は TOTP 未登録なら TRUE を返す設計（#623）なので、
  //      aal1 を作るには**登録済みの利用者でサインインしたまま昇格しない**必要がある。
  describe('aal2 に上げていない admin は読めない（M-011 を倒す）', () => {
    const PASSWORD = 'Passw0rd!aal1-priv'
    const mfaEmail = `priv-mfa-admin-${marker}@example.test`
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

    it('aal1 の admin は 1 件も読めない（メールが漏れない）', async () => {
      const client = await aal1()
      const { data, error } = await client.from('privileged_operations').select('id, target_email')
      // RLS は拒否ではなく不可視（error なしで 0 件）
      expect(error).toBeNull()
      expect(data).toEqual([])
    })

    it('対照: aal2 まで上げれば読める（admin の権限そのものは設計どおり）', async () => {
      // WHY(対照が要る): 「0 件」だけを見ていると、行が存在しないだけでも通ってしまう。
      //      同じ利用者が昇格したら読めることまで見て、初めて aal2 が効いていると言える
      //      （M-010 の教訓: 空の表に対して「読めない」を確かめても何も確かめていない）
      const client = await aal1()
      await stepUpToAal2(client, factorId, secret)
      const { data, error } = await client.from('privileged_operations').select('id, target_email')
      expect(error).toBeNull()
      expect((data ?? []).length).toBeGreaterThan(0)
    })
  })

  it('記録できない環境でもヘルパーは例外を投げない（特権操作を止めない）', async () => {
    // WHY: 記録は証跡であって操作そのものではない。DB に届かなくても招待・削除は成立させる
    //      （fail-open だが、これは「記録の失敗」であって「認可の失敗」ではない）
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    process.env.NEXT_PUBLIC_SUPABASE_URL = ''
    try {
      const m = await import('@/lib/security/privileged-operation')
      m.resetPrivilegedOperationClientForTests()
      await expect(
        m.recordPrivilegedOperation({ operation: 'user_invite', succeeded: true, actorId: admin.id }),
      ).resolves.toBeUndefined()
    } finally {
      process.env.NEXT_PUBLIC_SUPABASE_URL = url
      const m = await import('@/lib/security/privileged-operation')
      m.resetPrivilegedOperationClientForTests()
    }
  })
})
