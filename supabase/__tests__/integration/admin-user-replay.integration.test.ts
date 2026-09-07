// supabase/__tests__/integration/admin-user-replay.integration.test.ts
// WHY: issue #757 の 38（部分成功、M-005 / M-006 / M-020 / M-023）。admin 画面の書き込みは
//      「利用者の作成 → メール送信」（GoTrue 内の 2 段）や「削除 → CASCADE」のように複数段で、
//      応答が届かなかった admin は同じ操作をもう一度押す。そのとき行が増えない・残骸が残らない・
//      2 回目が安全に終わることを本物の Auth と DB で固定する。
//      招待の再送は Supabase 側の挙動なので、版が変わって「再招待がエラーになる」「2 人目ができる」に
//      なったらここで気づく（画面の再送ボタンの前提が崩れる）。

import { randomUUID } from 'crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { createFacility, createServiceRoleClient } from './helpers/seed-rls-idor'

const serviceClient = createServiceRoleClient()
const createdUserIds: string[] = []
const createdFacilityIds: string[] = []

async function countUsersByEmail(email: string): Promise<number> {
  const { data, error } = await serviceClient.auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  return data.users.filter((u) => u.email === email).length
}

async function createConfirmedUser(prefix: string): Promise<string> {
  const { data, error } = await serviceClient.auth.admin.createUser({
    email: `${prefix}-${randomUUID()}@example.test`,
    password: 'Replay-test-password-1',
    email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  createdUserIds.push(data.user.id)
  return data.user.id
}

async function countLinks(userId: string, facilityId: string): Promise<number> {
  const { count, error } = await serviceClient
    .from('user_facilities')
    .select('user_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('facility_id', facilityId)
  if (error) throw error
  return count ?? 0
}

afterAll(async () => {
  for (const id of createdUserIds) await serviceClient.auth.admin.deleteUser(id)
  for (const id of createdFacilityIds) await serviceClient.from('facilities').delete().eq('id', id)
})

// 部分成功の棚卸し（docs/agents/partial-success-inventory.md）: M-020 招待の再送は同じ利用者に再送する
describe('招待の再送（inviteUserByEmail を同じメールへ 2 回） [M-020]', () => {
  it('未確認の招待先へもう一度招待すると、同じ利用者（id 不変）に invited_at を更新して再送し、利用者は 1 人のまま', async () => {
    const email = `invite-replay-${Date.now()}@example.test`
    const first = await serviceClient.auth.admin.inviteUserByEmail(email)
    expect(first.error).toBeNull()
    createdUserIds.push(first.data.user!.id)
    expect(first.data.user!.email_confirmed_at ?? null).toBeNull()

    const second = await serviceClient.auth.admin.inviteUserByEmail(email)
    expect(second.error).toBeNull()
    expect(second.data.user!.id).toBe(first.data.user!.id)
    expect(new Date(second.data.user!.invited_at!).getTime()).toBeGreaterThanOrEqual(
      new Date(first.data.user!.invited_at!).getTime(),
    )
    expect(await countUsersByEmail(email)).toBe(1)
  })

  it('確認済みの利用者へ招待すると 422 で拒否され、利用者は 1 人のまま', async () => {
    const email = `invite-replay-confirmed-${Date.now()}@example.test`
    const created = await serviceClient.auth.admin.createUser({
      email,
      password: 'Replay-test-password-1',
      email_confirm: true,
    })
    expect(created.error).toBeNull()
    createdUserIds.push(created.data.user!.id)

    const invite = await serviceClient.auth.admin.inviteUserByEmail(email)
    expect(invite.error).not.toBeNull()
    expect(invite.error!.status).toBe(422)
    expect(await countUsersByEmail(email)).toBe(1)
  })
})

// M-023 施設割当の upsert は同じ組み合わせで 1 行のまま（role だけ更新される）
describe('施設割当の再送（user_facilities の upsert を 2 回） [M-023]', () => {
  it('同じ利用者 × 施設を 2 回 upsert しても 1 行のままで、2 回目の role が残る', async () => {
    const facility = await createFacility(serviceClient, `replay-upsert-${randomUUID()}`)
    createdFacilityIds.push(facility.id)
    const userId = await createConfirmedUser('replay-upsert-user')

    const row = { user_id: userId, facility_id: facility.id }
    const first = await serviceClient.from('user_facilities').upsert({ ...row, role: 'staff' }, { onConflict: 'user_id,facility_id' })
    expect(first.error).toBeNull()
    const second = await serviceClient.from('user_facilities').upsert({ ...row, role: 'viewer' }, { onConflict: 'user_id,facility_id' })
    expect(second.error).toBeNull()

    expect(await countLinks(userId, facility.id)).toBe(1)
    const { data } = await serviceClient.from('user_facilities').select('role').eq('user_id', userId).eq('facility_id', facility.id).single()
    expect(data?.role).toBe('viewer')
  })
})

// M-006 利用者削除は user_facilities を CASCADE で消し、2 回目は「利用者が無い」で止まる
describe('利用者削除の再送（deleteUser を 2 回） [M-006]', () => {
  it('1 回目で所属も消え、2 回目はエラーになるが何も壊さない', async () => {
    const facility = await createFacility(serviceClient, `replay-delete-user-${randomUUID()}`)
    createdFacilityIds.push(facility.id)
    const userId = await createConfirmedUser('replay-delete-user')
    const link = await serviceClient.from('user_facilities').insert({ user_id: userId, facility_id: facility.id, role: 'staff' })
    expect(link.error).toBeNull()
    expect(await countLinks(userId, facility.id)).toBe(1)

    const first = await serviceClient.auth.admin.deleteUser(userId)
    expect(first.error).toBeNull()
    createdUserIds.splice(createdUserIds.indexOf(userId), 1)
    expect(await countLinks(userId, facility.id)).toBe(0)

    const second = await serviceClient.auth.admin.deleteUser(userId)
    expect(second.error).not.toBeNull()
    expect(second.error!.status).toBe(404)
    // 施設は残る（利用者削除は施設に波及しない）
    const { data: fac } = await serviceClient.from('facilities').select('id').eq('id', facility.id).maybeSingle()
    expect(fac?.id).toBe(facility.id)
  })
})

// M-005 施設削除は所属を CASCADE で消し、2 回目は 0 行（エラーにならない）
describe('施設削除の再送（DELETE facilities を 2 回） [M-005]', () => {
  it('1 回目で所属が消え、2 回目は 0 行で何も起きない', async () => {
    const facility = await createFacility(serviceClient, `replay-delete-facility-${randomUUID()}`)
    const userId = await createConfirmedUser('replay-delete-facility-user')
    const link = await serviceClient.from('user_facilities').insert({ user_id: userId, facility_id: facility.id, role: 'staff' })
    expect(link.error).toBeNull()

    const first = await serviceClient.from('facilities').delete().eq('id', facility.id).select('id')
    expect(first.error).toBeNull()
    expect(first.data).toHaveLength(1)
    expect(await countLinks(userId, facility.id)).toBe(0)

    const second = await serviceClient.from('facilities').delete().eq('id', facility.id).select('id')
    expect(second.error).toBeNull()
    expect(second.data).toHaveLength(0)
    // 利用者本人は残る（別施設に所属しうる。D-004）
    const { data } = await serviceClient.auth.admin.getUserById(userId)
    expect(data.user?.id).toBe(userId)
  })
})
