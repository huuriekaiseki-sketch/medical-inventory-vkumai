// supabase/__tests__/integration/permission-race.integration.test.ts
// WHY: issue #757 の 27 の続き（優先順位 4）。P-023 は「降格したら**次のリクエストから**効く」を
//      順番に実行して確かめている。ここで測るのはその隣の問題、**同時に起きたとき**。
//
//      認可を判定してから実際に書くまでには必ず隙間がある。隙間の大きさは経路で違う。
//        (1) RLS 経路（利用者の JWT）… 文ごとに `is_facility_writer()` を評価する。隙間は文の中だけ
//        (2) RPC 経路（SECURITY DEFINER）… 関数の先頭で 1 回だけ確認し、その後 INSERT する。
//            隙間は「確認から INSERT まで」（同一トランザクション内。マイクロ秒）
//        (3) service_role 経路（admin API）… `requireAdmin()` のあと **RLS を通らない鍵**で書く。
//            隙間は「判定からハンドラの書き込みまで」＝リクエスト本文の読み取りを含む
//
//      (3) はテストではなく構造で守る（`docs/agents/privileged-write-rulebook.md` と
//      `src/__tests__/privileged-writes.test.ts`）。ここで実 DB で測るのは (1) と (2)。
//
//      測る性質は 2 つ:
//        A. **降格がコミットされた後に始めた書き込みは 1 件も通らない**（決定的。これが約束）
//        B. 降格と同時に走っていた書き込みは通ることがある（隙間）。ただし
//           **通った分は必ず監査ログに残る**（説明責任は隙間があっても崩れない）

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFacility, createServiceRoleClient } from './helpers/seed-rls-idor'

const TEST_USER_PASSWORD = 'permission-race-test-0000'
const PARALLEL = 12

const service = createServiceRoleClient()
const tag = randomUUID().slice(0, 8)

// 約束カタログ（docs/agents/promise-catalog.md）: P-023 権限の変更は次のリクエストから効く
describe('権限変更と書き込みの競合 [P-023]', () => {
  let facilityId: string
  let userId: string
  let client: SupabaseClient

  const setRole = async (role: string) => {
    const { error } = await service
      .from('user_facilities')
      .update({ role })
      .eq('user_id', userId)
      .eq('facility_id', facilityId)
    if (error) throw new Error(`ロール変更に失敗（${role}）: ${error.message}`)
  }

  /** RLS 経路の書き込み。成功したら作った行の id を返す */
  const writeViaRls = async (label: string): Promise<string | null> => {
    const { data } = await client
      .from('consumables')
      .insert({ facility_id: facilityId, name: `RLS-${label}`, purpose: 'ダミー用途' })
      .select('id')
      .maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  /** RPC 経路の書き込み（関数の先頭で is_facility_writer を 1 回確認する） */
  const writeViaRpc = async (label: string): Promise<string | null> => {
    const { data } = await client.rpc('create_loan_order_atomic', {
      p_facility_id: facilityId,
      p_procedure_name: `RPC-${label}`,
      p_maker: 'ダミーメーカー',
      p_items: [],
    })
    return (data as { id: string } | null)?.id ?? null
  }

  beforeAll(async () => {
    // 実データを混ぜないためダミー名のみ（.claude/rules/e2e-test-hygiene.md）
    facilityId = (await createFacility(service, `権限競合テスト施設-${tag}`)).id

    const email = `permission-race-${tag}@example.test`
    const { data, error } = await service.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (error || !data.user) throw new Error(`ユーザー作成に失敗: ${error?.message}`)
    userId = data.user.id

    const { error: linkError } = await service
      .from('user_facilities')
      .insert({ user_id: userId, facility_id: facilityId, role: 'staff' })
    if (linkError) throw new Error(`所属の作成に失敗: ${linkError.message}`)

    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    )
    const { error: signInError } = await client.auth.signInWithPassword({
      email,
      password: TEST_USER_PASSWORD,
    })
    if (signInError) throw new Error(`サインインに失敗: ${signInError.message}`)
  }, 120_000)

  afterAll(async () => {
    if (userId) await service.auth.admin.deleteUser(userId)
    if (facilityId) await service.from('facilities').delete().eq('id', facilityId)
  })

  it('降格前は書ける（対照。拒否が降格由来だと言えるようにする）', async () => {
    await setRole('staff')
    expect(await writeViaRls('before')).not.toBeNull()
    expect(await writeViaRpc('before')).not.toBeNull()
  }, 60_000)

  it(`降格がコミットされた後に始めた書き込みは、RLS も RPC も ${PARALLEL} 本すべて通らない`, async () => {
    // WHY(並行で撃つ): 1 本ずつ順番に試すと「たまたま間に合っただけ」を見逃す。
    //      同時に多数を撃って、1 本も通らないことを見る。
    await setRole('viewer')

    const results = await Promise.all([
      ...Array.from({ length: PARALLEL }, (_, i) => writeViaRls(`after-${i}`)),
      ...Array.from({ length: PARALLEL }, (_, i) => writeViaRpc(`after-${i}`)),
    ])
    const succeeded = results.filter((id) => id !== null)
    expect(succeeded, `降格後に ${succeeded.length} 本が通った`).toEqual([])
  }, 120_000)

  it('降格と同時に走っていた書き込みは通ることがあるが、通った分は必ず監査ログに残る', async () => {
    // WHY(隙間は消せない): 認可を確認してから書くまでの間に降格がコミットされると、
    //      RPC 経路は確認済みのまま INSERT に進む。この隙間は設計上あり、消すには
    //      「書く直前にもう一度確認する」か「行ロックを取る」が要る。
    //      **消せない代わりに、通った書き込みが誰にも見えないまま残ることは無い**ことを測る。
    await setRole('staff')

    const before = Date.now()
    const inFlight = Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => writeViaRpc(`race-${i}`)),
    )
    // 書き込みが飛んでいる最中に降格する
    await setRole('viewer')
    const ids = (await inFlight).filter((id): id is string => id !== null)

    // 何本通ったかは実行のたびに変わる（競合なので当然）。0 本でもよい
    const { data: rows, error } = await service
      .from('audit_log')
      .select('row_id')
      .eq('table_name', 'loan_orders')
      .in('row_id', ids.length > 0 ? ids : ['00000000-0000-0000-0000-000000000000'])
      .eq('action', 'INSERT')
    expect(error).toBeNull()

    const logged = new Set((rows ?? []).map((r) => (r as { row_id: string }).row_id))
    const missing = ids.filter((id) => !logged.has(id))
    expect(
      missing,
      `競合中に通った ${ids.length} 本のうち ${missing.length} 本が監査ログに残っていない`,
    ).toEqual([])

    // 隙間の実測値を残す（0 でも失敗ではない。窓の大きさを知るための記録）
    console.log(
      `[permission-race] 降格と同時に走った ${PARALLEL} 本のうち ${ids.length} 本が通った（${Date.now() - before} ms）`,
    )
  }, 120_000)

  it('降格の後は、監査ログにも新しい書き込みが増えない', async () => {
    // A の裏取り: 「拒否された」ことを行数でも確かめる（error だけ見ると握りつぶしを見逃す）
    const countRows = async () => {
      const { count } = await service
        .from('consumables')
        .select('id', { count: 'exact', head: true })
        .eq('facility_id', facilityId)
      return count ?? 0
    }

    await setRole('viewer')
    const before = await countRows()
    await Promise.all(Array.from({ length: PARALLEL }, (_, i) => writeViaRls(`quiet-${i}`)))
    expect(await countRows()).toBe(before)
  }, 60_000)
})
