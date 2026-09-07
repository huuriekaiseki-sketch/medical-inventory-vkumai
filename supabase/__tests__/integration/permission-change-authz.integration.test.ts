// supabase/__tests__/integration/permission-change-authz.integration.test.ts
// WHY: issue #757 の 27 の続き。2026-09-07 の「権限変更と書き込みの競合」の調査で、
//      窓より大きい穴が見つかった。
//
//      20260906000008（#623 の続き、P-033）はマスタの書き込みに `has_aal2()` を足したが、
//      **所属と役割の変更（誰を admin にするか）には aal2 が要らないまま**だった。
//      理由は経路の違いで、マスタは利用者の JWT → RLS を通るのに対し、所属の変更は
//      管理 API が **service_role（RLS を通らない鍵）**で書いており、認可は `requireAdmin()`
//      だけ（aal2 を見ていない）だったため。
//
//      結果として、パスワードだけを奪われた admin（MFA 登録済み・aal1）はマスタを直接は
//      書けないのに、**共犯者を admin に昇格させることはできた**。#623 と P-033 で塞いだ
//      つもりの経路を、権限を配る側から迂回できる状態だった。
//
//      20260907030000 で `user_facilities` に `is_admin() AND has_aal2()` の書き込みポリシーを
//      作り、管理 API を利用者の JWT に切り替えた（P-035）。ここで実 DB で確かめる。
//
//      副産物として「判定してから書くまでの窓」も消える（認可の再評価が書き込みと同じ文で起きる）。
//      窓そのものの実測は permission-race.integration.test.ts。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFacility, createServiceRoleClient } from './helpers/seed-rls-idor'

const TEST_USER_PASSWORD = 'permission-change-authz-0000'

const service = createServiceRoleClient()
const tag = randomUUID().slice(0, 8)

interface Actor {
  id: string
  email: string
  client: SupabaseClient
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  )
  const { error } = await client.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
  if (error) throw new Error(`サインインに失敗（${email}）: ${error.message}`)
  return client
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-035 所属と役割の変更は admin かつ aal2
describe('所属と役割の変更は admin かつ aal2 を要求する [P-035]', () => {
  let facilityId: string
  let admin: Actor
  let staff: Actor
  let target: Actor

  const createActor = async (label: string, role: string | null): Promise<Actor> => {
    const email = `permission-change-${label}-${tag}@example.test`
    const { data, error } = await service.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (error || !data.user) throw new Error(`ユーザー作成に失敗（${label}）: ${error?.message}`)
    if (role) {
      const { error: linkError } = await service
        .from('user_facilities')
        .insert({ user_id: data.user.id, facility_id: facilityId, role })
      if (linkError) throw new Error(`所属の作成に失敗（${label}）: ${linkError.message}`)
    }
    return { id: data.user.id, email, client: await signIn(email) }
  }

  beforeAll(async () => {
    // 実データを混ぜないためダミー名のみ（.claude/rules/e2e-test-hygiene.md）
    facilityId = (await createFacility(service, `権限変更テスト施設-${tag}`)).id
    admin = await createActor('admin', 'admin')
    staff = await createActor('staff', 'staff')
    target = await createActor('target', null)
  }, 120_000)

  afterAll(async () => {
    for (const a of [admin, staff, target]) {
      if (a) await service.auth.admin.deleteUser(a.id)
    }
    if (facilityId) await service.from('facilities').delete().eq('id', facilityId)
  })

  it('MFA 未登録の admin は所属を作れる（既存の運用を壊さない）', async () => {
    // WHY: has_aal2() は verified な TOTP factor を持たない利用者に TRUE を返す。
    //      MFA を使っていない現状の運用は今までどおり動く（#623 と同じ設計）。
    const { data, error } = await admin.client
      .from('user_facilities')
      .insert({ user_id: target.id, facility_id: facilityId, role: 'staff' })
      .select('user_id')
    expect(error, `admin が所属を作れない: ${error?.message}`).toBeNull()
    expect(data).toHaveLength(1)
  }, 60_000)

  it('admin は役割を書き換えられる（昇格も降格も）', async () => {
    const promote = await admin.client
      .from('user_facilities')
      .update({ role: 'admin' })
      .eq('user_id', target.id)
      .eq('facility_id', facilityId)
      .select('role')
    expect(promote.error).toBeNull()
    expect(promote.data).toHaveLength(1)

    const demote = await admin.client
      .from('user_facilities')
      .update({ role: 'viewer' })
      .eq('user_id', target.id)
      .eq('facility_id', facilityId)
      .select('role')
    expect(demote.error).toBeNull()
    expect(demote.data).toHaveLength(1)
  }, 60_000)

  it('**staff は自分を admin に昇格できない**（いちばん守りたいところ）', async () => {
    const { data, error } = await staff.client
      .from('user_facilities')
      .update({ role: 'admin' })
      .eq('user_id', staff.id)
      .eq('facility_id', facilityId)
      .select('role')
    // RLS は拒否ではなく不可視にするので、error ではなく 0 行になる
    expect(data ?? []).toHaveLength(0)
    expect(error).toBeNull()

    // 実際に role が変わっていないことを service_role で確かめる（0 行の主張の裏取り）
    const { data: actual } = await service
      .from('user_facilities')
      .select('role')
      .eq('user_id', staff.id)
      .eq('facility_id', facilityId)
      .single()
    expect((actual as { role: string }).role).toBe('staff')
  }, 60_000)

  it('staff は他人の所属を作れない・消せない', async () => {
    const insert = await staff.client
      .from('user_facilities')
      .insert({ user_id: staff.id, facility_id: facilityId, role: 'admin' })
      .select('user_id')
    expect(insert.error, 'staff が所属を作れてしまった').not.toBeNull()

    const del = await staff.client
      .from('user_facilities')
      .delete()
      .eq('user_id', target.id)
      .eq('facility_id', facilityId)
      .select('user_id')
    expect(del.data ?? []).toHaveLength(0)

    const { count } = await service
      .from('user_facilities')
      .select('user_id', { count: 'exact', head: true })
      .eq('user_id', target.id)
      .eq('facility_id', facilityId)
    expect(count).toBe(1)
  }, 60_000)

  it('所属の変更は監査ログに残る（誰が権限を配ったかを後から追える）', async () => {
    const { data } = await service
      .from('audit_log')
      .select('action, actor_id, new_data')
      .eq('table_name', 'user_facilities')
      .filter('new_data->>user_id', 'eq', target.id)
      .order('occurred_at')
    const rows = (data ?? []) as Array<{ action: string; actor_id: string | null }>
    expect(rows.length, '所属の変更が監査ログに残っていない').toBeGreaterThan(0)
    // admin の JWT で書いたので actor_id が入る（service_role で書いていた頃は null だった）
    expect(rows.some((r) => r.actor_id === admin.id), '誰が変えたかが残っていない').toBe(true)
  }, 60_000)

  it('admin は所属を消せる', async () => {
    const { data, error } = await admin.client
      .from('user_facilities')
      .delete()
      .eq('user_id', target.id)
      .eq('facility_id', facilityId)
      .select('user_id')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  }, 60_000)
})
