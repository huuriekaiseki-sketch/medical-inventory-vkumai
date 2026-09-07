// supabase/__tests__/integration/role-capabilities.integration.test.ts
// WHY: issue #757 の 27 の続き。既存の rbac-viewer-role は viewer を名指しで測っており、
//      **4 つ目のロールを足しても新しいテストは 1 本も増えなかった**。
//
//      ここは docs/agents/role-rulebook.md（R-xxx）を読んで**全ロールを回す**。
//      表に 1 行足せば自動で測定対象になり、宣言と実測が食い違えばここで落ちる。
//      静的な突合（SQL / TypeScript の許可リストとの一致）は
//      supabase/migrations/__tests__/role_registry.test.ts が見る。ここは実 DB での実測だけ。
//
//      測るのは宣言した 3 つの軸そのもの:
//        施設の行を読む / 施設の行を書く / マスタを書く
//      「画面の書き込み UI」は DB では測れないので静的側に任せる（実装と宣言の一致まで）。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROLE_REGISTRY } from '../helpers/role-registry'
import { createFacility, createServiceRoleClient } from './helpers/seed-rls-idor'

const TEST_USER_PASSWORD = 'role-capabilities-test-0000'

const service = createServiceRoleClient()
const tag = randomUUID().slice(0, 8)

// 約束カタログ（docs/agents/promise-catalog.md）: P-020 viewer は閲覧のみ / P-021 マスタは admin だけ
describe('ロールごとにできることを実 DB で測る（表に足したロールは必ず測られる） [P-020 P-021]', () => {
  const roles = Object.values(ROLE_REGISTRY).filter((r) => r.status === '実装済み')
  const clients = new Map<string, SupabaseClient>()
  const userIds: string[] = []
  let facilityId: string
  let consumableId: string
  let categoryId: string

  beforeAll(async () => {
    // 実データを混ぜないためダミー名のみ（.claude/rules/e2e-test-hygiene.md）
    facilityId = (await createFacility(service, `ロール実測テスト施設-${tag}`)).id

    const consumable = await service
      .from('consumables')
      .insert({ facility_id: facilityId, name: 'ダミー消耗品', purpose: 'ダミー用途' })
      .select('id')
      .single()
    consumableId = (consumable.data as { id: string }).id

    const category = await service
      .from('categories')
      .insert({ name: `ロール実測分類-${tag}` })
      .select('id')
      .single()
    categoryId = (category.data as { id: string }).id

    for (const decl of roles) {
      const email = `role-capabilities-${decl.role}-${tag}@example.test`
      const { data, error } = await service.auth.admin.createUser({
        email,
        password: TEST_USER_PASSWORD,
        email_confirm: true,
      })
      if (error || !data.user) throw new Error(`ユーザー作成に失敗（${decl.role}）: ${error?.message}`)
      userIds.push(data.user.id)

      const { error: linkError } = await service
        .from('user_facilities')
        .insert({ user_id: data.user.id, facility_id: facilityId, role: decl.role })
      if (linkError) {
        // WHY: DB の CHECK に無いロールを表に書くと、ここで落ちる（静的側でも落ちるが二重の受け）
        throw new Error(`所属の作成に失敗（${decl.role}）: ${linkError.message}`)
      }

      const client = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      )
      const { error: signInError } = await client.auth.signInWithPassword({
        email,
        password: TEST_USER_PASSWORD,
      })
      if (signInError) throw new Error(`サインインに失敗（${decl.role}）: ${signInError.message}`)
      clients.set(decl.role, client)
    }
  }, 120_000)

  afterAll(async () => {
    for (const id of userIds) await service.auth.admin.deleteUser(id)
    if (facilityId) await service.from('facilities').delete().eq('id', facilityId)
    if (categoryId) await service.from('categories').delete().eq('id', categoryId)
  })

  it('表に載っているロールを 1 つ残らず測っている（測り漏れの検知）', () => {
    // fail-open 防止: ロールが 0 件だと下のテストが何も測らないまま緑になる
    expect(roles.length).toBeGreaterThanOrEqual(3)
    for (const decl of roles) {
      expect(clients.get(decl.role), `${decl.role} のセッションを作れていない`).toBeDefined()
    }
  })

  it('「施設の行を読む」が宣言どおり', async () => {
    const problems: string[] = []
    for (const decl of roles) {
      const { data, error } = await clients
        .get(decl.role)!
        .from('consumables')
        .select('id')
        .eq('id', consumableId)
      const canRead = !error && (data ?? []).length > 0
      if (canRead !== decl.reads) {
        problems.push(`${decl.id}（${decl.role}）: 実際 ${canRead ? '読める' : '読めない'} / 宣言 ${decl.reads ? '読める' : '読めない'}`)
      }
    }
    expect(problems).toEqual([])
  }, 60_000)

  it('「施設の行を書く」が宣言どおり（RLS と発注 RPC の両方）', async () => {
    const problems: string[] = []
    for (const decl of roles) {
      const client = clients.get(decl.role)!

      // (a) 表への直接 INSERT
      const { error: insertError } = await client
        .from('consumables')
        .insert({ facility_id: facilityId, name: `直接書き込み-${decl.role}`, purpose: 'ダミー用途' })
      const canInsert = !insertError
      if (canInsert !== decl.writes) {
        problems.push(`${decl.id}（${decl.role}）: 直接 INSERT は 実際 ${canInsert ? '書ける' : '書けない'} / 宣言 ${decl.writes ? '書ける' : '書けない'}`)
      }

      // (b) 発注 RPC（is_facility_writer を関数内で見る経路。RLS とは別の入口）
      const { error: rpcError } = await client.rpc('create_loan_order_atomic', {
        p_facility_id: facilityId,
        p_procedure_name: `ダミー術式-${decl.role}`,
        p_maker: 'ダミーメーカー',
        p_items: [],
      })
      const canRpc = !rpcError
      if (canRpc !== decl.writes) {
        problems.push(`${decl.id}（${decl.role}）: 発注 RPC は 実際 ${canRpc ? '書ける' : '書けない'} / 宣言 ${decl.writes ? '書ける' : '書けない'}`)
      }
    }
    expect(problems).toEqual([])
  }, 120_000)

  it('「マスタを書く」が宣言どおり', async () => {
    const problems: string[] = []
    for (const decl of roles) {
      // WHY(UPDATE で測る): マスタの書き込みは admin かつ aal2 を要求する（P-033）。
      //      MFA 未登録の利用者は has_aal2() が TRUE を返すので、ロールの軸だけが残る。
      const { data, error } = await clients
        .get(decl.role)!
        .from('categories')
        .update({ description: `更新-${decl.role}` })
        .eq('id', categoryId)
        .select('id')
      const canWriteMaster = !error && (data ?? []).length > 0
      if (canWriteMaster !== decl.admin) {
        problems.push(`${decl.id}（${decl.role}）: 実際 ${canWriteMaster ? '書ける' : '書けない'} / 宣言 ${decl.admin ? '書ける' : '書けない'}`)
      }
    }
    expect(problems).toEqual([])
  }, 60_000)
})
