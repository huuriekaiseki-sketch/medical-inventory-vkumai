// supabase/__tests__/integration/schema-drift-rpc-authz.integration.test.ts
// WHY: PR #760 の RPC 公開判定（P-043）の初回計測で、schema drift 系 4 関数が「service_role のみ」の
//      注記に反して PostgreSQL 既定の PUBLIC 権限で anon から呼べていた（2026-09-06 実測:
//      anon キーで check_schema_drift() と record_issue_url() が成功）。SECURITY DEFINER の書き込み
//      関数を誰でも呼べると、drift 検知の baseline と記録を書き換えて監視を盲目にできる。
//      20260906000001 で REVOKE した後、anon / authenticated が実 DB で拒否され、service_role は
//      引き続き呼べることを確かめる。static テスト（migration の文字列）だけでは「効いている」は
//      証明できない（feedback: green でも修正が効いていない型）ので、拒否コードまで見る。
//
// 注意（2026-09-07 更新）: 元々「drift 記録テーブル名をこのファイルに書かない」としていた。
//       constraint_coverage_ratchet の「制約 migration の統合テスト対応」判定はテーブル名の登場で
//       決まるためで、制約を試していないのに covered と読まれるのを避ける意図だった。
//       末尾に読み取り権限のテスト（20260907010000）を足したため両テーブル名が登場するが、
//       この 2 表は同判定の対象になる制約を持たないことを `scripts/check-constraint-coverage.sh`
//       で実測して確認した（穴 0 のまま変わらない）。制約を足すときはここを見直すこと。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertTestSupabaseEnv } from '../../../e2e/env-guard'

const TEST_USER_PASSWORD = 'schema-drift-rpc-authz-0000'

// PostgreSQL の permission denied（PostgREST は SQLSTATE をそのまま code に載せる）
const PERMISSION_DENIED = '42501'

type RpcCall = { name: string; args: Record<string, unknown> }
// 読み取り専用の 2 本は実引数で呼ぶ。書き込み 2 本は「存在しない id / 現在の epoch を再設定」で
// 副作用が出ない引数にする（service_role で成功させる必要は無いので拒否だけを見る）
const CALLS: RpcCall[] = [
  { name: 'check_schema_drift', args: {} },
  { name: 'record_schema_drift', args: {} },
  { name: 'record_issue_url', args: { log_id: randomUUID(), url: 'https://example.invalid/authz-test' } },
  { name: 'refresh_schema_baseline_snapshot', args: { new_epoch: `authz-test-${randomUUID()}` } },
]

function createServiceRoleClient(): SupabaseClient {
  assertTestSupabaseEnv()
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('[schema-drift-rpc-authz] NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY が未設定です。')
  }
  return createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
}

function createAnonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-044 schema drift 系 RPC は service_role 以外から呼べない
describe('schema drift 系 RPC は anon / authenticated から呼べない [P-044]', () => {
  const runId = randomUUID()
  const serviceClient = createServiceRoleClient()
  let userId: string
  let authenticatedClient: SupabaseClient

  beforeAll(async () => {
    // 施設に所属しない素の authenticated ユーザー（所属の有無は関数権限に関係ない）
    const email = `schema-drift-rpc-authz-${runId}@example.test`
    const { data, error } = await serviceClient.auth.admin.createUser({
      email,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
    })
    if (error || !data.user) throw new Error(`ユーザー作成失敗: ${error?.message}`)
    userId = data.user.id
    authenticatedClient = createAnonClient()
    const { error: signInError } = await authenticatedClient.auth.signInWithPassword({ email, password: TEST_USER_PASSWORD })
    if (signInError) throw new Error(`サインイン失敗: ${signInError.message}`)
  })

  afterAll(async () => {
    if (userId) await serviceClient.auth.admin.deleteUser(userId)
  })

  it.each(CALLS)('anon: $name は permission denied（42501）で拒否される', async ({ name, args }) => {
    const { data, error } = await createAnonClient().rpc(name, args)
    expect(error?.code, `${name} が anon で呼べてしまった: ${JSON.stringify(data)}`).toBe(PERMISSION_DENIED)
  })

  it.each(CALLS)('authenticated: $name は permission denied（42501）で拒否される', async ({ name, args }) => {
    const { data, error } = await authenticatedClient.rpc(name, args)
    expect(error?.code, `${name} が authenticated で呼べてしまった: ${JSON.stringify(data)}`).toBe(PERMISSION_DENIED)
  })

  it('service_role: check_schema_drift() は引き続き呼べる（REVOKE ALL FROM PUBLIC で巻き添えにしていない）', async () => {
    const { error } = await serviceClient.rpc('check_schema_drift')
    expect(error).toBeNull()
  })

  // WHY: 2026-09-07 まで、監視の記録テーブルは **service_role でも読めなかった**
  //      （GRANT が 1 行も書かれていなかった。permission denied for table schema_drift_log）。
  //      そのせいで夜間の不変条件検査を守るテストが「記録されたか」を確かめられず、
  //      ずっと落ちたままだった（記録そのものは動いていた）。20260907010000 で service_role
  //      にだけ SELECT を与えた。読める側と読めない側の両方を測って固定する。
  describe.each(['schema_drift_log', 'schema_baseline_snapshots'])('%s の読み取り権限', (table) => {
    it('service_role は読める', async () => {
      const { error } = await serviceClient.from(table).select('*').limit(1)
      expect(error, `${table} を service_role が読めない: ${error?.message}`).toBeNull()
    })

    it('anon は読めない', async () => {
      const { error } = await createAnonClient().from(table).select('*').limit(1)
      expect(error, `${table} が anon から読めてしまった`).not.toBeNull()
    })

    it('authenticated は読めない', async () => {
      const { error } = await authenticatedClient.from(table).select('*').limit(1)
      expect(error, `${table} が authenticated から読めてしまった`).not.toBeNull()
    })
  })
})
