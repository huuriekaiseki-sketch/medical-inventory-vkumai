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
