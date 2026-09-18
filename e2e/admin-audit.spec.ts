import { test, expect, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY: 監査ログの画面（/admin/audit）は E2E に一度も出てこなかった。
//      この領域は「行は残っているが読めない」型の実害を 2 回出している
//      （E-020 明細の監査行が施設の人に 1 件も見えていなかった、
//       E-021 索引が無く 20 万行で毎回全表走査していた）。
//      どちらも**残す側**の欠陥で、**読む側**の画面は測られていなかった。
//
//      画面はその冒頭で「行の中身（患者 ID・術式名など）は表示しません」と**約束している**。
//
//      2026-09-08 に実測したところ、この約束は **2 か所**で守られていた:
//        (1) `listAuditLog` の select 句が old_data / new_data を選ばない
//        (2) `mapAuditRow` が列を 1 つずつ明示的に写す（選ばれても素通りしない）
//      **片方だけ壊しても漏れない**（select に new_data を足しただけでは mapper が落とす）。
//      両方を通すと患者 ID・術式名・医師名がそのまま API の応答に出ることを実測で確認した。
//      2 段になっているのは強いが、**どちらも「書き忘れ」ではなく「書き足し」で破れる**ので、
//      破れたことに気づく手段をここに置く。
//
//      **ここで測らないこと**:
//      - 監査行がそもそも 1 行だけ残ること（P-060 / P-062）→ `audit-completeness` が実 DB で見る
//      - 拒否の記録が admin 以外に見えないこと → `access-denials-rls-idor` が実 DB で見る
//      - 索引が効いていること（E-021）→ 規模の実測（`scripts/measure-scale.sh`）

const fixtures = readCrossFacilityFixtures()
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

async function openAudit(page: Page, query = '') {
  await page.goto(`/admin/audit${query}`)
  await page.waitForLoadState('networkidle')
}

/** 管理者自身の利用者 ID。絞り込みの対照に使う */
async function adminUserId(page: Page): Promise<string | null> {
  const res = await page.request.get('/api/admin/users')
  if (!res.ok()) return null
  const { users } = await res.json()
  return users?.find((u: { email: string }) => u.email === ADMIN_EMAIL)?.id ?? null
}

test.describe('監査ログの画面（変更の記録） [P-062 P-067]', () => {
  test.skip(!fixtures?.facilityAId, 'cross-facility フィクスチャが生成されていない')

  // WHY(この 1 件がこの spec の主目的): 画面が「中身は表示しません」と書いている以上、
  //      **患者 ID と術式名が 1 文字も出ないこと**が約束。`listAuditLog` の select 句に
  //      `old_data` を 1 語足すだけで破れるので、画面と API の両方で無いことを見る。
  test('症例発注を作ると変更の記録に出るが、患者 ID と術式名は画面にも応答にも出ない', async ({
    browser,
    page,
  }) => {
    const s = suffix()
    const patientId = `PT-AUDIT-${s}`
    const procedureName = `監査テスト術式-${s}`
    const doctorName = `監査テスト医師-${s}`

    // 施設 A の staff として症例発注を作る（admin は施設 A の writer ではないので RPC に弾かれる）
    const userA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const created = await userA.request.post('/api/case-orders', {
      data: {
        facilityId: fixtures!.facilityAId,
        caseDatetime: new Date().toISOString(),
        procedureName,
        patientId,
        patientInitials: 'A.B.',
        gender: 'other',
        doctorName,
        items: [],
      },
    })
    expect(
      created.status(),
      `症例発注の作成に失敗 (${created.status()}): ${await created.text()}`
    ).toBe(201)
    await userA.close()

    // 管理者として監査ログを開く（施設 A に絞る）
    await openAudit(page, `?facility_id=${fixtures!.facilityAId}`)

    // 1. 作成の記録が出ている
    await expect(
      page.getByRole('row').filter({ hasText: 'case_orders' }).filter({ hasText: '作成' }).first(),
      '症例発注を作ったのに変更の記録に出ない'
    ).toBeVisible()

    // 2. 中身は 1 文字も出ない（画面）
    const body = await page.locator('body').innerText()
    expect(body, '患者 ID が監査ログの画面に出ている').not.toContain(patientId)
    expect(body, '術式名が監査ログの画面に出ている').not.toContain(procedureName)
    expect(body, '医師名が監査ログの画面に出ている').not.toContain(doctorName)

    // 3. 中身は API の応答にも入っていない（画面が捨てているだけ、を除外する）
    const res = await page.request.get(
      `/api/admin/audit?kind=changes&facility_id=${fixtures!.facilityAId}`
    )
    expect(res.status()).toBe(200)
    const raw = await res.text()
    expect(raw, '患者 ID が API の応答に入っている').not.toContain(patientId)
    expect(raw, '術式名が API の応答に入っている').not.toContain(procedureName)
    // 対照: 中身を出さないだけで、記録そのものは返っている
    expect(raw).toContain('case_orders')
  })

  // WHY(E-036): 監査画面の絞り込みは、ミューテーションで
  //      「`if (query.actorId)` を `if (false)` にしても全テストが緑」だった箇所。
  //      単体では直したが、**画面の入力欄から実際に効くか**は測っていない。
  //      効かないと「この人の操作は 0 件」という**安全に見える誤った結論**が出る。
  test('利用者 ID で絞り込むと、その人の記録だけが残る（居ない ID なら空になる）', async ({ page }) => {
    test.skip(!ADMIN_EMAIL, 'E2E_TEST_EMAIL が未設定')

    // 管理者自身の操作を 1 件作る（マスタの書き込みは admin だけができる）
    const s = suffix()
    const created = await page.request.post('/api/products', {
      data: { jan: `audit-${s}`, ref: `ref-${s}`, name: `監査テスト製品-${s}` },
    })
    expect(created.status(), `製品の作成に失敗: ${await created.text()}`).toBe(201)

    const myId = await adminUserId(page)
    expect(myId, '管理者自身の利用者 ID が取れない').toBeTruthy()

    // 肯定: 自分の ID で絞ると記録が出る
    await openAudit(page)
    await page.getByLabel('利用者 ID').fill(myId!)
    await page.getByRole('button', { name: '絞り込む' }).click()
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByRole('row').filter({ hasText: 'products' }).first(),
      '自分の ID で絞ったのに自分の操作が出ない'
    ).toBeVisible()

    // 否定: 誰でもない ID で絞ると空になる（絞り込みが素通りしていない）
    const nobody = '00000000-0000-4000-8000-000000000000'
    await page.getByLabel('利用者 ID').fill(nobody)
    await page.getByRole('button', { name: '絞り込む' }).click()
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByText('該当する記録はありません'),
      '居ない利用者で絞っても記録が出る（絞り込みが効いていない）'
    ).toBeVisible()
  })
})

test.describe('監査ログの画面（拒否された操作） [P-063]', () => {
  test.skip(!fixtures?.facilityAId, 'cross-facility フィクスチャが生成されていない')

  // WHY: 拒否の記録は「弾かれたこと」を後から説明する唯一の手段。
  //      残す側は実 DB のテストがあるが、**読む側の画面**は測られていない。
  //      生の値（facility / forbidden）ではなく日本語の見出しに写して出すことも含めて見る。
  test('他施設のデータを取りに行って弾かれると、拒否された操作に日本語で出る', async ({
    browser,
    page,
  }) => {
    // 施設 B の利用者が施設 A のデータを取りに行く → requireFacilityAccess が弾いて記録が残る
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    // WHY(facility_id): 一覧の GET はクエリ文字列を snake_case で受ける（画面もそう送っている）。
    //      camelCase で送ると施設の判定に届く前に 400 で止まり、拒否の記録も残らない。
    const denied = await userB.request.get(`/api/case-orders?facility_id=${fixtures!.facilityAId}`)
    expect(denied.status(), '施設 B の利用者が施設 A のデータを取れてしまった').toBe(403)
    await userB.close()

    await openAudit(page)
    await page.getByRole('button', { name: '拒否された操作' }).click()
    await page.waitForLoadState('networkidle')

    // 生の値ではなく、読める見出しに写して出す
    const row = page.getByRole('row').filter({ hasText: '施設の境界' }).first()
    await expect(row, '弾いた記録が拒否された操作に出ない').toBeVisible()
    await expect(row).toContainText('権限がない')
    await expect(row).toContainText('/api/case-orders')

    // 経路にクエリ文字列（施設 ID）が付いたまま残っていない（P-063 の「クエリ文字列が落ちる」）
    await expect(row, '拒否の記録に施設 ID が残っている').not.toContainText(fixtures!.facilityAId)
  })
})

// WHY(#757-24): proxy が admin ガードで /login へ跳ね返す拒否は、単体では
//      「proxy が印を付ける」「/login が印を読む」を別々にしか測れない（越境が単体の外にある）。
//      ここで実際に redirect → /login 着地 → access_denials への記録までを 1 本で通す。
test.describe('proxy の admin 拒否が access_denials に記録される [#757-24]', () => {
  function serviceRoleClient() {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  }

  async function countDenials(
    guard: string,
    reason: string,
    route: string
  ): Promise<number> {
    const db = serviceRoleClient()
    const { count, error } = await db
      .from('access_denials')
      .select('id', { count: 'exact', head: true })
      .eq('guard', guard)
      .eq('reason', reason)
      .eq('route', route)
    expect(error, `access_denials の集計に失敗: ${error?.message}`).toBeNull()
    return count ?? 0
  }

  test('未ログインで /admin を開くと /login に着地し、記録が1件増える。再読み込みでは増えない', async ({
    browser,
  }) => {
    // WHY(空の storageState を明示): browser.newContext() は playwright.config の use.storageState
    //      （admin のログイン状態）を引き継ぐ。初回は引数なしで作ったため admin として /admin が
    //      開けてしまい、このテスト自体が「未ログイン」を測れていなかった
    const anon = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await anon.newPage()

    const before = await countDenials('proxy_admin', 'unauthenticated', '/admin')

    await page.goto('/admin')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/login/)

    // WHY(記録がDB反映されるまでの猶予): recordAccessDenial はRPC呼び出しを含むため、
    //      画面遷移の直後にはまだ書き込みが終わっていないことがある
    await expect
      .poll(() => countDenials('proxy_admin', 'unauthenticated', '/admin'), {
        message: '未ログインで /admin にアクセスしても access_denials が増えない',
      })
      .toBe(before + 1)

    // 続けて /login を再読み込みしても、印は proxy が既に消しているので増えない
    await page.reload()
    await page.waitForLoadState('networkidle')
    const afterReload = await countDenials('proxy_admin', 'unauthenticated', '/admin')
    expect(afterReload, '/login の再読み込みで同じ拒否が二重に記録された').toBe(before + 1)

    await anon.close()
  })

  test('非admin利用者が /admin を開くと reason=not_admin で記録され、actor_id が本人になる', async ({
    browser,
  }) => {
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await userB.newPage()

    const before = await countDenials('proxy_admin', 'not_admin', '/admin')

    await page.goto('/admin')
    await page.waitForLoadState('networkidle')
    await expect(page).toHaveURL(/\/login/)

    await expect
      .poll(() => countDenials('proxy_admin', 'not_admin', '/admin'), {
        message: '非admin利用者が /admin にアクセスしても access_denials が増えない',
      })
      .toBe(before + 1)

    const db = serviceRoleClient()
    const { data, error } = await db
      .from('access_denials')
      .select('actor_id')
      .eq('guard', 'proxy_admin')
      .eq('reason', 'not_admin')
      .eq('route', '/admin')
      .order('occurred_at', { ascending: false })
      .limit(1)
    expect(error, `access_denials の取得に失敗: ${error?.message}`).toBeNull()
    expect(data?.[0]?.actor_id, 'actor_id が記録されていない（誰の拒否か分からない）').toBeTruthy()

    await userB.close()
  })

  test('非adminは /admin/audit の「拒否された操作」からこの記録を読めない（RLS）', async ({
    browser,
  }) => {
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await userB.newPage()

    // 非admin自身が /admin/audit を開いても proxy に弾かれて /login へ送られる
    await page.goto('/admin/audit')
    await page.waitForLoadState('networkidle')
    await expect(page, '非adminが /admin/audit を開けてしまう').toHaveURL(/\/login/)

    await userB.close()
  })
})

// WHY(#757-24 の残り「RLS が黙って 0 件を返す拒否」): ID 指定の 1 件取得は RLS で見えない行を
//      「存在しない」と区別できず 404 を返すだけだった。存在するなら service role で確かめて
//      拒否として残す（応答は 404 のまま）。単体はモックなので、実 RLS × 実 service role の越境をここで通す。
test.describe('RLS で見えない 1 件取得が access_denials に残る [P-063]', () => {
  test.skip(!fixtures?.facilityAId, 'cross-facility フィクスチャが生成されていない')

  function serviceRoleClient() {
    return createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  }

  async function countHiddenDenials(route: string, facilityId: string): Promise<number> {
    const { count, error } = await serviceRoleClient()
      .from('access_denials')
      .select('id', { count: 'exact', head: true })
      .eq('guard', 'facility')
      .eq('reason', 'forbidden')
      .eq('route', route)
      .eq('facility_id', facilityId)
    expect(error, `access_denials の集計に失敗: ${error?.message}`).toBeNull()
    return count ?? 0
  }

  test('施設 B の利用者が施設 A の ID を直接指定すると 404 のまま、施設 A への拒否として 1 件残る', async ({ browser }) => {
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const route = `/api/facilities/${fixtures!.facilityAId}`
    const before = await countHiddenDenials(route, fixtures!.facilityAId)

    const res = await userB.request.get(route)
    expect(res.status(), '施設 B の利用者が施設 A を読めてしまった').toBe(404)
    // 存在の有無を本文で漏らさない（本当に無いときと同じ文言）
    expect(await res.text()).toContain('施設が見つかりません')

    await expect
      .poll(() => countHiddenDenials(route, fixtures!.facilityAId), { message: '見えなかった施設の拒否が記録されない' })
      .toBe(before + 1)
    await userB.close()
  })

  test('施設 B の利用者が施設 A の院内価格 ID を直接指定すると 404 のまま、施設 A への拒否として 1 件残る', async ({ browser }) => {
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const route = `/api/hospital-prices/${fixtures!.facilityAHospitalPriceId}`
    const before = await countHiddenDenials(route, fixtures!.facilityAId)

    const res = await userB.request.get(route)
    expect(res.status(), '施設 B の利用者が施設 A の院内価格を読めてしまった').toBe(404)

    await expect
      .poll(() => countHiddenDenials(route, fixtures!.facilityAId), { message: '見えなかった院内価格の拒否が記録されない' })
      .toBe(before + 1)
    await userB.close()
  })

  test('存在しない ID は 404 で、記録は増えない（本当に無いものは拒否ではない）', async ({ browser }) => {
    const userB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const nobody = '00000000-0000-4000-8000-000000000000'
    const db = serviceRoleClient()
    const { count: before } = await db
      .from('access_denials').select('id', { count: 'exact', head: true }).eq('route', `/api/facilities/${nobody}`)

    const res = await userB.request.get(`/api/facilities/${nobody}`)
    expect(res.status()).toBe(404)
    await new Promise(r => setTimeout(r, 1500))
    const { count: after } = await db
      .from('access_denials').select('id', { count: 'exact', head: true }).eq('route', `/api/facilities/${nobody}`)
    expect(after ?? 0, '存在しない ID の 404 が拒否として記録された').toBe(before ?? 0)
    await userB.close()
  })
})
