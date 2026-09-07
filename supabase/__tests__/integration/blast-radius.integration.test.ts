// supabase/__tests__/integration/blast-radius.integration.test.ts
// WHY: issue #757 の 39（内部不正・乗っ取り後の被害限定）。「admin のパスワードだけが漏れた」
//      前提で、そのセッション（MFA 登録済み・aal1）が実際にどこまで届くかを実 DB で測る。
//      設計上の期待ではなく実測を固定するのが目的で、範囲が広がる変更（新しい表・新しい
//      ポリシー・aal2 要求の削除）が入ったらここが落ちる。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'
import { enrollAndVerifyTotp, signInAtAal1, stepUpToAal2 } from './helpers/mfa-totp'

const PASSWORD = 'blast-radius-admin-test-0000'

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('[blast-radius] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。')
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } })
}

function createAnonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 影響範囲の棚卸し（docs/agents/blast-radius.md）: B-xxx
describe('乗っ取られた admin（パスワードのみ・aal1）の到達範囲 [B-001 B-002 B-003 B-004 P-033]', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()
  const adminEmail = `blast-radius-admin-${runId}@example.test`

  let adminId: string
  let factorId: string
  let secret: string
  /** admin が所属する施設 */
  let ownFacilityId: string
  /** admin がどの施設にも所属していない、別テナントの施設 */
  let otherFacilityId: string
  let otherOrderId: string
  let productId: string
  const jan = `39${runId.replace(/-/g, '').slice(0, 10)}`

  beforeAll(async () => {
    const { data: own } = await serviceClient.from('facilities').insert({ name: `影響範囲-自施設-${runId}` }).select('id').single()
    ownFacilityId = own!.id as string
    const { data: other } = await serviceClient.from('facilities').insert({ name: `影響範囲-他施設-${runId}` }).select('id').single()
    otherFacilityId = other!.id as string

    const { data: user, error: userError } = await serviceClient.auth.admin.createUser({
      email: adminEmail,
      password: PASSWORD,
      email_confirm: true,
    })
    if (userError || !user.user) throw new Error(`ユーザー作成失敗: ${userError?.message}`)
    adminId = user.user.id
    const { error: linkError } = await serviceClient
      .from('user_facilities')
      .insert({ user_id: adminId, facility_id: ownFacilityId, role: 'admin' })
    if (linkError) throw new Error(`所属作成失敗: ${linkError.message}`)

    // 他施設に患者情報を含む発注を 1 件置く（読めてしまうかを測るため）
    const { data: order, error: orderError } = await serviceClient
      .from('case_orders')
      .insert({
        facility_id: otherFacilityId,
        case_datetime: new Date().toISOString(),
        procedure_name: '他施設の手技',
        patient_id: `PT-BLAST-${runId}`,
        patient_initials: 'B.R.',
        gender: 'other',
        doctor_name: '他施設の医師',
      })
      .select('id')
      .single()
    if (orderError || !order) throw new Error(`他施設の発注作成失敗: ${orderError?.message}`)
    otherOrderId = order.id as string

    const { data: product, error: productError } = await serviceClient
      .from('products')
      .insert({ jan, ref: `REF-${jan}`, name: `影響範囲テスト製品-${runId}` })
      .select('id')
      .single()
    if (productError || !product) throw new Error(`製品作成失敗: ${productError?.message}`)
    productId = product.id as string

    const client = createAnonClient()
    await signInAtAal1(client, adminEmail, PASSWORD)
    const enrolled = await enrollAndVerifyTotp(client)
    factorId = enrolled.factorId
    secret = enrolled.secret
  }, 60_000)

  afterAll(async () => {
    await serviceClient.auth.admin.deleteUser(adminId)
    await serviceClient.from('products').delete().eq('jan', jan)
    await serviceClient.from('facilities').delete().in('id', [ownFacilityId, otherFacilityId])
  })

  async function aal1(): Promise<SupabaseClient> {
    const client = createAnonClient()
    await signInAtAal1(client, adminEmail, PASSWORD)
    return client
  }

  // B-001 読み取り: aal1 のまま全施設の業務データに届く（RLS の SELECT に has_aal2 が無い）
  it('B-001 パスワードだけで、所属していない施設の発注と患者 ID まで読める（読み取りに aal2 は要らない）', async () => {
    const client = await aal1()
    const { data, error } = await client
      .from('case_orders')
      .select('id, facility_id, patient_id, patient_initials, doctor_name')
      .eq('id', otherOrderId)
      .single()
    expect(error).toBeNull()
    expect(data!.facility_id).toBe(otherFacilityId)
    expect(data!.patient_id).toBe(`PT-BLAST-${runId}`)

    // 施設の一覧も全件見える（テナントの数がそのまま到達範囲になる）
    const { data: facilities } = await client.from('facilities').select('id').in('id', [ownFacilityId, otherFacilityId])
    expect(facilities).toHaveLength(2)
  })

  // B-002 書き込み（施設スコープ）: aal2 が無いと拒否される
  it('B-002 施設スコープの表への書き込みは、自施設でも他施設でも aal1 では拒否される', async () => {
    const client = await aal1()
    const row = {
      case_datetime: new Date().toISOString(),
      procedure_name: '乗っ取りテスト',
      patient_id: 'PT-BLAST-W',
      patient_initials: 'B.W.',
      gender: 'other',
      doctor_name: '医師',
    }
    const own = await client.from('case_orders').insert({ ...row, facility_id: ownFacilityId })
    expect(own.error).not.toBeNull()
    const other = await client.from('case_orders').insert({ ...row, facility_id: otherFacilityId })
    expect(other.error).not.toBeNull()

    // 他施設の既存行の書き換え・削除も 0 行で終わる
    const update = await client.from('case_orders').update({ procedure_name: '改ざん' }).eq('id', otherOrderId).select('id')
    expect(update.data ?? []).toHaveLength(0)
    const del = await client.from('case_orders').delete().eq('id', otherOrderId).select('id')
    expect(del.data ?? []).toHaveLength(0)
  })

  // B-003 / P-033 書き込み（マスタ）: aal2 まで上げないと変えられない
  //   2026-09-06 の初回計測ではここが通っていた（マスタ 4 表の書き込みポリシーが is_admin() だけで
  //   has_aal2() を含んでいなかった）。20260906000008 で塞いだ回帰テスト。
  it('B-003 マスタ（products）の変更・削除は aal1 では 0 行で終わり、aal2 まで上げると通る [P-033]', async () => {
    const client = await aal1()
    const update = await client.from('products').update({ name: '改ざんされた製品名' }).eq('id', productId).select('id')
    expect(update.error === null ? (update.data ?? []).length : 0).toBe(0)
    const del = await client.from('products').delete().eq('id', productId).select('id')
    expect(del.error === null ? (del.data ?? []).length : 0).toBe(0)

    // 対照: aal2 まで上げれば admin として通る（権限があること自体は設計どおり）
    await stepUpToAal2(client, factorId, secret)
    const ok = await client.from('products').update({ name: `影響範囲テスト製品-${runId}-v2` }).eq('id', productId).select('id')
    expect(ok.error).toBeNull()
    expect(ok.data).toHaveLength(1)
  })

  // B-003 の対照。施設の新規作成も aal2 が要る（テナントを増やす操作の被害が大きいため）
  it('B-003 施設の新規作成も aal1 では拒否される [P-033]', async () => {
    const client = await aal1()
    const { error } = await client.from('facilities').insert({ name: `影響範囲-aal1作成-${runId}` }).select('id')
    expect(error).not.toBeNull()
  })

  // B-004 検知: 書き込みは監査ログに残るが、読み取りは 1 行も残らない
  it('B-004 aal2 での変更は audit_log に残るが、B-001 の読み取りは痕跡を残さない', async () => {
    const { data: rows, error } = await serviceClient
      .from('audit_log')
      .select('id, action, actor_id, table_name')
      .eq('table_name', 'products')
      .eq('row_id', productId)
    expect(error).toBeNull()
    const updates = (rows ?? []).filter((r) => r.action === 'UPDATE')
    expect(updates.length).toBeGreaterThanOrEqual(1)
    expect(updates.some((r) => r.actor_id === adminId)).toBe(true)

    // 読み取りの証跡は存在しない（SELECT はトリガーに来ない。#757-24 の残り）
    const { data: selectRows } = await serviceClient
      .from('audit_log')
      .select('id')
      .eq('table_name', 'case_orders')
      .eq('row_id', otherOrderId)
      .eq('action', 'SELECT')
    expect(selectRows ?? []).toHaveLength(0)
  })
})
