// supabase/__tests__/integration/mfa-unenroll-boundary.integration.test.ts
//
// WHY(2026-09-09): `has_aal2()` は「**verified な TOTP が 1 つも無ければ TRUE**」を返す
//      （20260806000001。MFA 未登録の利用者を締め出さないための設計）。
//      つまり **MFA を解除できれば aal2 の要求はまるごと外れる**。
//      発注の取り消し・マスタの書き込みなど、危険度の高い操作の関門は aal2 だけなので、
//      解除の境界が抜けていると **上に積んだ守りが全部意味を失う**。
//
//      ところがこの境界を守っているのは**このリポジトリのコードではなく Supabase（GoTrue）**で、
//      テストが 1 本も無かった。他人の実装に載っている約束は、
//      版が上がった日に黙って外れる（`load-bearing-workarounds.md` と同じ型）。
//      **実測して固定する。**
//
// 測ること:
//   1. aal1（パスワードだけ）のセッションでは verified な factor を解除できない
//   2. aal2 まで昇格すれば解除できる（対照。1 が「そもそも解除できない」で緑になっていない）
//   3. 解除した後は、**パスワードだけのセッションで書けるようになる**
//      → これは穴ではなく設計（MFA は任意）。ただし
//        **「一度でも外せば、そのユーザーの aal2 の守りは無くなる」**ことを測って残す。
//        受け入れるかは人の判断（`docs/agents/threat-model.md` T-002）。

import { randomUUID } from 'crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServiceRoleClient, createFacility, createSeededUser, type SeededUser } from './helpers/seed-rls-idor'
import { enrollAndVerifyTotp, stepUpToAal2 } from './helpers/mfa-totp'
import { isRlsRejected, describeDenial } from './helpers/pg-error'

/** `createSeededUser` が使うパスワード（違う値を書くと黙って未ログインになる） */
const PASSWORD = 'rls-idor-test-password-0000'

function anonClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-034 二段階認証の昇格
describe('MFA の解除は aal2 を要求する（aal2 の関門が外から外れないこと） [P-034]', () => {
  const runId = randomUUID()
  let service: SupabaseClient
  let facility: { id: string; name: string }
  let user: SeededUser
  let factorId: string
  let secret: string

  beforeAll(async () => {
    service = createServiceRoleClient()
    facility = await createFacility(service, `MFA解除境界-${runId}`)
    user = await createSeededUser(service, 'mfa-unenroll-boundary', facility.id, 'staff')
    const enrolled = await enrollAndVerifyTotp(user.client)
    factorId = enrolled.factorId
    secret = enrolled.secret
  }, 120_000)

  afterAll(async () => {
    if (user) await service.auth.admin.deleteUser(user.id)
    if (facility) await service.from('facilities').delete().eq('id', facility.id)
  })

  /** パスワードだけでサインインした新しいセッション */
  async function signInAtAal1(): Promise<SupabaseClient> {
    const client = anonClient()
    const { error } = await client.auth.signInWithPassword({ email: user.email, password: PASSWORD })
    if (error) throw new Error(`[mfa-unenroll] サインイン失敗: ${error.message}`)
    return client
  }

  it('aal1 のセッションでは verified な factor を解除できない（**この 1 行が aal2 の関門を支えている**）', async () => {
    const aal1 = await signInAtAal1()

    // 前提: この時点では aal1 なので書けない
    const { error: writeBefore } = await aal1
      .from('consumables')
      .insert({ facility_id: facility.id, name: `解除前-${runId}`, purpose: '境界テスト' })
    expect(isRlsRejected(writeBefore), `aal1 で書けてしまった: ${describeDenial(writeBefore)}`).toBe(true)

    const { error } = await aal1.auth.mfa.unenroll({ factorId })
    expect(error, 'aal1 のセッションで MFA を解除できてしまった（aal2 の関門が迂回できる）').not.toBeNull()
    // WHY(文言まで見る): 「たまたま別の理由で失敗した」を「守られている」と読まないため（C-020）。
    //      2026-09-09 実測: 422 "AAL2 required to unenroll verified factor"
    expect(error?.message, '拒否の理由が aal2 由来でない').toContain('AAL2')

    // 解除できていないので、依然として書けない
    const { error: writeAfter } = await aal1
      .from('consumables')
      .insert({ facility_id: facility.id, name: `解除試行後-${runId}`, purpose: '境界テスト' })
    expect(isRlsRejected(writeAfter), `解除に失敗したのに書けてしまった: ${describeDenial(writeAfter)}`).toBe(true)
  }, 60_000)

  // WHY(対照): 「解除できない」だけを測ると、**そもそも解除の機能が壊れていても緑**になる（C-021）。
  //      aal2 なら解除できることを対で測って、上の拒否が aal2 由来だと確かめる
  it('aal2 まで昇格すれば解除できる（対照）', async () => {
    const aal2 = await signInAtAal1()
    await stepUpToAal2(aal2, factorId, secret)

    const { error } = await aal2.auth.mfa.unenroll({ factorId })
    expect(error, `aal2 でも解除できない（解除の経路自体が壊れている）: ${error?.message}`).toBeNull()
  }, 60_000)

  // WHY(設計を測って残す): MFA は任意なので、外した利用者に aal2 は要求されない
  //      （`has_aal2()` は verified な factor が無ければ TRUE）。
  //      **つまり「一度でも外せば、そのユーザーの aal2 の守りは無くなる」**。
  //      穴ではなく決めごとだが、決めごとだと分かるように実測を残す（T-002）。
  it('解除したあとは、パスワードだけのセッションで書けるようになる（MFA は任意という設計の帰結）', async () => {
    const passwordOnly = await signInAtAal1()

    const { data, error } = await passwordOnly
      .from('consumables')
      .insert({ facility_id: facility.id, name: `解除後-${runId}`, purpose: '境界テスト' })
      .select('id')
    expect(error, `MFA を外したのに書けない（has_aal2 の設計が変わっている）: ${describeDenial(error)}`).toBeNull()
    expect(data ?? []).toHaveLength(1)
  }, 60_000)
})
