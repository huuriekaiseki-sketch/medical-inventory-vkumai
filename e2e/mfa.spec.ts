// e2e/mfa.spec.ts
// WHY: 二段階認証まわりの画面（`/account/mfa`・`/mfa-challenge`）は**一度も E2E で開かれていなかった**
//      （2026-09-09 時点）。DB 側の aal2 は `blast-radius.integration.test.ts` が実物の TOTP で
//      両方向を測っているが、そこで測っているのは「aal1 だと読めない」ことだけで、
//      **利用者が aal2 まで上がる道が画面に存在するか**は誰も測っていなかった。
//
//      ここが壊れたときの被害は「MFA を有効にした利用者が、自施設のデータを二度と見られない」
//      （＝ロックアウト）。RLS は 11 の表の SELECT に `has_aal2()` を要求しており（20260907000001）、
//      `has_aal2()` は**検証済み factor を持つ利用者にだけ**効く。つまり有効化した瞬間から、
//      challenge 画面が通らない利用者は全部 0 行になる。**有効化の画面と challenge の画面は対**で、
//      片方だけ動いても意味がない。
//
//      測る順序（この 2 本は依存関係があるので serial）:
//        1. 画面から有効化できる（シークレットを画面から読み、コードを入れて「有効です」になる）
//        2. その後、パスワード相当の新しいセッション（マジックリンク＝aal1）では
//           保護ページが開けず /mfa-challenge に飛ばされ、コードを入れると元のデータに戻れる
//
// WHY(自分の施設と利用者を作る): 施設 A は複数の spec が同時に触る共有フィクスチャで、
//      ここでは利用者に MFA を付けるという**後戻りしにくい変更**を加える。
//      他の spec の利用者に factor が付くと、その spec 全部が aal1 で 0 行になって壊れる。

import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { signInAndSaveStorageState } from './generate-auth-state'
import { generateTotp } from '../supabase/__tests__/integration/helpers/mfa-totp'

const MFA_AUTH_PATH = path.join(process.cwd(), 'e2e', '.auth', 'mfa-user.json')

function serviceRoleClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface OwnFixture {
  facilityId: string
  userId: string
  email: string
  procedureName: string
  loanOrderId: string
}

let own: OwnFixture | null = null
/** テスト 1 で画面から読み取ったシークレット。テスト 2 の challenge で使う */
let totpSecret: string | null = null

/** 画面の「シークレットキー: XXXX」から生の secret を取り出す */
async function readSecretFromScreen(page: Page): Promise<string> {
  const text = await page.getByText(/シークレットキー:/).innerText()
  const secret = (text.split('シークレットキー:')[1] ?? '').trim()
  expect(secret, '画面にシークレットキーが出ていない').not.toBe('')
  return secret
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-034 施設スコープの読み取りにも aal2
test.describe.configure({ mode: 'serial' })
test.describe('二段階認証の有効化と昇格（画面から） [P-034]', () => {
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（シードに必要）')

  test.beforeAll(async () => {
    const db = serviceRoleClient()
    const runId = randomUUID()

    const { data: facility, error: fError } = await db
      .from('facilities')
      .insert({ name: `テスト施設MFA-${runId}` })
      .select('id')
      .single()
    if (fError || !facility) throw new Error(`[mfa] 施設のシード失敗: ${fError?.message}`)

    const email = `e2e-mfa-user-${runId}@example.test`
    const { data: user, error: uError } = await db.auth.admin.createUser({ email, email_confirm: true })
    if (uError || !user.user) throw new Error(`[mfa] 利用者のシード失敗: ${uError?.message}`)

    const { error: mError } = await db
      .from('user_facilities')
      .insert({ user_id: user.user.id, facility_id: facility.id, role: 'staff' })
    if (mError) throw new Error(`[mfa] 所属のシード失敗: ${mError.message}`)

    // 「昇格したあと、本当に元のデータが見えるか」を測るための 1 件
    const procedureName = `MFAテスト用術式-${runId}`
    const { data: order, error: oError } = await db
      .from('loan_orders')
      .insert({ facility_id: facility.id, procedure_name: procedureName, maker: 'MFAテスト用メーカー' })
      .select('id')
      .single()
    if (oError || !order) throw new Error(`[mfa] 短貸発注のシード失敗: ${oError?.message}`)

    own = {
      facilityId: facility.id as string,
      userId: user.user.id,
      email,
      procedureName,
      loanOrderId: order.id as string,
    }
    await signInAndSaveStorageState(db, email, MFA_AUTH_PATH)
  })

  test.afterAll(async () => {
    if (!own) return
    const db = serviceRoleClient()
    await db.from('loan_orders').delete().eq('id', own.loanOrderId)
    await db.from('user_facilities').delete().eq('user_id', own.userId)
    await db.auth.admin.deleteUser(own.userId)
    await db.from('facilities').delete().eq('id', own.facilityId)
    fs.rmSync(MFA_AUTH_PATH, { force: true })
    own = null
  })

  test('画面から二段階認証を有効にできる（シークレットを読み、コードを入れると「有効です」になる）', async ({ browser }) => {
    const context = await browser.newContext({ storageState: MFA_AUTH_PATH })
    const page = await context.newPage()
    await page.goto('/account/mfa')

    await expect(page.getByText('二段階認証は現在無効です。', { exact: false })).toBeVisible()
    await page.getByRole('button', { name: '二段階認証を有効化する' }).click()

    // QR とシークレットが出る。認証アプリの代わりにシークレットから直接コードを作る
    await expect(page.getByAltText('MFA QRコード')).toBeVisible()
    totpSecret = await readSecretFromScreen(page)

    await page.getByLabel('確認コード').fill(generateTotp(totpSecret))
    await page.getByRole('button', { name: '確認して有効化' }).click()

    await expect(page.getByText('✓ 二段階認証は有効です。')).toBeVisible()
    // 解除の道も同じ画面にあること（有効化しかできないと、間違えた人が戻れない）
    await expect(page.getByRole('button', { name: '二段階認証を解除する' })).toBeVisible()

    await context.close()
  })

  test('有効にしたあと、昇格していないセッションでは施設のデータが見えず、コードを入れると戻れる', async ({ browser }) => {
    expect(totpSecret, '前のテストでシークレットを取得できていない').not.toBeNull()
    // タイムアウトの既定（30 秒）では、サインインし直し＋画面 2 枚分に足りないことがある
    test.setTimeout(120_000)

    // マジックリンクでのサインインは、factor が検証済みでも**新しいセッションは aal1 から始まる**
    // （src/proxy.ts の nextLevel 判定と同じ前提。helpers/mfa-totp.ts の signInAtAal1 と同じ意味）
    await signInAndSaveStorageState(serviceRoleClient(), own!.email, MFA_AUTH_PATH)

    const context = await browser.newContext({ storageState: MFA_AUTH_PATH })
    const page = await context.newPage()

    // 保護ページを開こうとすると /mfa-challenge へ飛ばされる（proxy.ts の MFA ガード）
    await page.goto(`/facilities/${own!.facilityId}/loan-orders`)
    await expect(page).toHaveURL(/\/mfa-challenge$/)
    await expect(page.getByText(own!.procedureName)).toHaveCount(0)

    // 画面だけでなく API も止まること（画面を迂回して直接叩かれても同じ）
    const apiRes = await page.request.get(`/api/loan-orders?facility_id=${own!.facilityId}`)
    expect(await apiRes.text()).not.toContain(own!.procedureName)

    // コードを入れると昇格し、元のデータが見える（＝ロックアウトしない）
    await expect(page.getByRole('heading', { name: '二段階認証' })).toBeVisible()
    await page.getByLabel('認証アプリの確認コード').fill(generateTotp(totpSecret!))
    await page.getByRole('button', { name: '確認する' }).click()

    await expect(page).toHaveURL(/\/$/)
    await page.goto(`/facilities/${own!.facilityId}/loan-orders`)
    await expect(page.getByText(own!.procedureName)).toBeVisible()

    await context.close()
  })
})
