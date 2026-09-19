import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY(issue #809): 症例発注・短貸返却の詳細ページ。一覧・ロット検索・/orders の
//      どこからでも同じ 1 件へ辿れること（決定 C）、他施設からは「見つかりません」に
//      畳まれること（受け入れ条件）、取り消し済みが文字で分かることを画面から測る。

const fixtures = readCrossFacilityFixtures()

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

function uniqueCaseDatetime() {
  const year = 2015 + Math.floor(Math.random() * 10)
  const month = 1 + Math.floor(Math.random() * 12)
  const day = 1 + Math.floor(Math.random() * 28)
  const hour = Math.floor(Math.random() * 24)
  const minute = Math.floor(Math.random() * 60)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${year}-${p2(month)}-${p2(day)}T${p2(hour)}:${p2(minute)}`
}

function serviceRoleClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

async function submitCaseOrder(page: Page, facilityId: string, procedureName: string, patientId: string) {
  await page.goto(`/facilities/${facilityId}/case-orders/new`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('症例日時').fill(uniqueCaseDatetime())
  await page.getByLabel('手技名').fill(procedureName)
  await page.getByLabel('患者ID').fill(patientId)
  await page.getByLabel('患者イニシャル').fill('T.E.')
  await page.getByLabel('担当医師').fill(`E2E医師-${uniqueSuffix()}`)
  await page.getByPlaceholder('JAN').first().fill(fixtures!.productJan!)
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/api/case-orders') && res.request().method() === 'POST'),
    page.getByRole('button', { name: '発注する' }).click(),
  ])
  return response
}

test.describe('症例発注の詳細ページ（issue #809）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('一覧の行から開ける。患者情報・明細が出て、一覧へキーボードだけで戻れる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()
    const procedureName = `E2E詳細ページ術式-${suffix}`
    const patientId = `PT-E2E-DETAIL-${suffix}`

    const created = await submitCaseOrder(page, fixtures!.facilityAId, procedureName, patientId)
    expect(created.status(), `POST /api/case-orders failed: ${await created.text()}`).toBe(201)

    await page.waitForLoadState('networkidle')
    const row = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: '詳細を見る' }).click()

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/[^/]+$`))
    await expect(page.getByRole('heading', { name: procedureName })).toBeVisible()
    await expect(page.getByText(patientId)).toBeVisible()
    await expect(page.getByText(fixtures!.productJan!)).toBeVisible()

    // キーボードだけで一覧へ戻れる（戻るリンクにフォーカスして Enter）
    const backLink = page.getByRole('link', { name: '症例発注の一覧へ戻る', exact: false })
    await backLink.focus()
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders$`))

    await context.close()
  })

  test('他施設の利用者が症例発注の詳細 URL を直接開くと「見つかりません」（患者情報は出ない）', async ({ browser }) => {
    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    const suffix = uniqueSuffix()
    const procedureName = `E2E他施設術式-${suffix}`
    const patientId = `PT-E2E-OTHER-${suffix}`
    const created = await submitCaseOrder(pageA, fixtures!.facilityAId, procedureName, patientId)
    expect(created.status()).toBe(201)
    // WHY: 作成後は一覧へ戻るだけで詳細へは飛ばない（case-orders.spec.ts と同じ挙動）。
    //      一覧の行の詳細リンク href から id を取り出す
    await pageA.waitForLoadState('networkidle')
    const row = pageA.getByRole('row', { name: new RegExp(procedureName) })
    const href = await row.getByRole('link', { name: '詳細を見る' }).getAttribute('href')
    await contextA.close()

    const orderId = href!.split('/').pop()
    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const pageB = await contextB.newPage()
    await pageB.goto(`/facilities/${fixtures!.facilityAId}/case-orders/${orderId}`)
    await pageB.waitForLoadState('networkidle')

    await expect(pageB.getByText('見つかりません', { exact: true })).toBeVisible()
    const html = await pageB.content()
    expect(html, '他施設の患者情報が画面に出ている').not.toContain(patientId)
    expect(html, '他施設の術式名が画面に出ている').not.toContain(procedureName)

    await contextB.close()
  })

  test('存在しない ID を直接開いても技術的なエラー文は出ず「見つかりません」になる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/case-orders/00000000-0000-4000-8000-000000000000`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('見つかりません', { exact: true })).toBeVisible()

    // 形式が不正な ID でも同じ（技術的なエラー文 `invalid input syntax` 等を出さない）
    await page.goto(`/facilities/${fixtures!.facilityAId}/case-orders/not-a-uuid`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText('見つかりません', { exact: true })).toBeVisible()
    const html = await page.content()
    expect(html).not.toContain('invalid input syntax')

    await context.close()
  })

  test('ロット検索の行から短貸返却の詳細ページを開ける（issue #803 でやめたリンクの復活）', async ({ browser }) => {
    // WHY(症例発注ではなく短貸返却を使う): 症例発注の新規登録フォームはロットを入力しない
    //      （src/app/facilities/[id]/case-orders/new/page.tsx にLOT欄が無い）ので、
    //      ロット番号で検索できるのは短貸返却の明細（loan_return_items）
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()
    const lot = `LOT-E2E-DETAIL-${suffix}`

    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-returns/new`)
    await page.waitForLoadState('networkidle')
    const year = 2015 + Math.floor(Math.random() * 10)
    await page.getByLabel('返却日時').fill(`${year}-01-01T00:00`)
    await page.getByPlaceholder('JAN').first().fill(fixtures!.productJan!)
    await page.getByPlaceholder('LOT').first().fill(lot)
    const [created] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/loan-returns') && res.request().method() === 'POST'),
      page.getByRole('button', { name: '返却する' }).click(),
    ])
    expect(created.status(), `POST /api/loan-returns failed: ${await created.text()}`).toBe(201)

    await page.goto(`/facilities/${fixtures!.facilityAId}/lot-search`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('ロット番号').fill(lot)
    await page.getByRole('button', { name: '検索する' }).click()
    await page.waitForLoadState('networkidle')

    const row = page.getByRole('row', { name: new RegExp(lot) })
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: '詳細を見る' }).click()

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns/[^/]+$`))
    await expect(page.getByText(lot, { exact: true })).toBeVisible()

    await context.close()
  })

  // WHY(SPEC.md Part2 セットD、仕様カバレッジ指摘の是正): 決定C=(3)で`/orders`からも開けるようにしたのに、
  //      `/orders`経由の到達をここで一度も測っていなかった。ロット検索・施設別一覧の2経路だけでは
  //      「症例発注は`/orders`からも開ける」ことを裏付けられない
  test('`/orders`（横断の一覧）の行から症例発注の詳細を開ける', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()
    const procedureName = `E2Eorders術式-${suffix}`
    const patientId = `PT-E2E-ORDERS-${suffix}`

    const created = await submitCaseOrder(page, fixtures!.facilityAId, procedureName, patientId)
    expect(created.status(), `POST /api/case-orders failed: ${await created.text()}`).toBe(201)

    await page.goto(
      `/orders?facilityId=${fixtures!.facilityAId}&kind=case_order&keyword=${encodeURIComponent(procedureName)}`
    )
    await page.waitForLoadState('networkidle')
    const row = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: '詳細を見る' }).click()

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/[^/]+$`))
    await expect(page.getByRole('heading', { name: procedureName })).toBeVisible()

    await context.close()
  })
})

// WHY(SPEC.md Part2 セットD、仕様カバレッジ指摘の是正): issue #803 のE2Eは「作ったばかりの記録」でしか
//      測っておらず、施設別一覧が持つ最新50件という上限より古い記録に届かないことを見逃した
//      （この issue #809 を立てた理由そのもの）。ここでは施設別一覧の上限を確実に超える件数を
//      直接シードし（UI 経由の作成は authenticated からの直接 INSERT が禁止されているため
//      service_role でシードする。20260909040000）、古い記録が施設別一覧には出ず、
//      `/orders`・ロット検索からは開けることを測る。
test.describe('51件目より古い記録の到達性（issue #809。#803のE2Eが見逃した観点）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（シードに必要）')

  // WHY(50件ちょうどではなく55件): 施設別一覧の上限は「最新50件」。並行して走る他のspecが
  //      同じ施設Aに行を足すことはあっても消すことはない（e2e-test-hygiene.md）ため、
  //      55件のフィラーがあれば対象の行が確実に上限の外へ押し出される
  const FILLER_COUNT = 55

  let oldCaseOrder: { id: string; procedureName: string } | null = null
  let oldLoanReturn: { id: string; lot: string } | null = null
  const createdCaseOrderIds: string[] = []
  const createdLoanReturnIds: string[] = []

  test.beforeAll(async () => {
    if (!fixtures?.productJan || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
    const db = serviceRoleClient()
    const suffix = uniqueSuffix()

    const oldProcedureName = `E2E古い症例発注-${suffix}`
    const { data: oldOrder, error: oldOrderError } = await db
      .from('case_orders')
      .insert({
        facility_id: fixtures.facilityAId,
        case_datetime: '2015-01-01T00:00:00Z',
        procedure_name: oldProcedureName,
        patient_id: `PT-OLD-${suffix}`,
        patient_initials: 'O.L.',
        gender: 'other',
        doctor_name: 'E2E古い医師',
        status: 'submitted',
        created_at: '2015-01-01T00:00:00Z',
      })
      .select('id')
      .single()
    if (oldOrderError || !oldOrder) {
      throw new Error(`[order-detail e2e] 古い症例発注のシード失敗: ${oldOrderError?.message}`)
    }
    oldCaseOrder = { id: oldOrder.id as string, procedureName: oldProcedureName }
    createdCaseOrderIds.push(oldOrder.id as string)

    const caseOrderFillers = Array.from({ length: FILLER_COUNT }, (_, i) => ({
      facility_id: fixtures!.facilityAId,
      case_datetime: new Date().toISOString(),
      procedure_name: `E2Eフィラー症例発注-${suffix}-${i}`,
      patient_id: `PT-FILLER-${suffix}-${i}`,
      patient_initials: 'F.L.',
      gender: 'other',
      doctor_name: 'E2Eフィラー医師',
      status: 'submitted',
    }))
    const { data: fillers, error: fillerError } = await db.from('case_orders').insert(caseOrderFillers).select('id')
    if (fillerError) throw new Error(`[order-detail e2e] フィラー症例発注のシード失敗: ${fillerError.message}`)
    createdCaseOrderIds.push(...(fillers ?? []).map((f) => f.id as string))

    const oldLot = `LOT-E2E-OLD-${suffix}`
    const { data: oldReturn, error: oldReturnError } = await db
      .from('loan_returns')
      .insert({
        facility_id: fixtures.facilityAId,
        return_datetime: '2015-01-01T00:00:00Z',
        status: 'returned',
        created_at: '2015-01-01T00:00:00Z',
      })
      .select('id')
      .single()
    if (oldReturnError || !oldReturn) {
      throw new Error(`[order-detail e2e] 古い短貸返却のシード失敗: ${oldReturnError?.message}`)
    }
    const { error: oldItemError } = await db.from('loan_return_items').insert({
      loan_return_id: oldReturn.id,
      jan: fixtures.productJan,
      lot: oldLot,
      quantity: 1,
    })
    if (oldItemError) throw new Error(`[order-detail e2e] 古い短貸返却の明細シード失敗: ${oldItemError.message}`)
    oldLoanReturn = { id: oldReturn.id as string, lot: oldLot }
    createdLoanReturnIds.push(oldReturn.id as string)

    const loanReturnFillers = Array.from({ length: FILLER_COUNT }, () => ({
      facility_id: fixtures!.facilityAId,
      return_datetime: new Date().toISOString(),
      status: 'returned',
    }))
    const { data: returnFillers, error: returnFillerError } = await db
      .from('loan_returns')
      .insert(loanReturnFillers)
      .select('id')
    if (returnFillerError) throw new Error(`[order-detail e2e] フィラー短貸返却のシード失敗: ${returnFillerError.message}`)
    createdLoanReturnIds.push(...(returnFillers ?? []).map((f) => f.id as string))
  })

  test.afterAll(async () => {
    if (!fixtures?.productJan || !process.env.SUPABASE_SERVICE_ROLE_KEY) return
    const db = serviceRoleClient()
    // WHY(自分が作った行だけ消す。e2e-test-hygiene.md): idを明示して.in()で絞る。
    //      施設Aは他specも同時に触る共有フィクスチャなので「施設Aの全部」は消さない
    if (createdCaseOrderIds.length > 0) await db.from('case_orders').delete().in('id', createdCaseOrderIds)
    if (createdLoanReturnIds.length > 0) await db.from('loan_returns').delete().in('id', createdLoanReturnIds)
  })

  test('施設別一覧の最新50件には出ないが、`/orders`からは開ける（症例発注）', async ({ browser }) => {
    test.skip(!oldCaseOrder, 'シードが失敗している')
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/case-orders`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(oldCaseOrder!.procedureName)).toHaveCount(0)

    await page.goto(
      `/orders?facilityId=${fixtures!.facilityAId}&kind=case_order&keyword=${encodeURIComponent(oldCaseOrder!.procedureName)}`
    )
    await page.waitForLoadState('networkidle')
    const row = page.getByRole('row', { name: new RegExp(oldCaseOrder!.procedureName) })
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: '詳細を見る' }).click()

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/[^/]+$`))
    await expect(page.getByRole('heading', { name: oldCaseOrder!.procedureName })).toBeVisible()

    await context.close()
  })

  test('施設別一覧の最新50件には出ないが、ロット検索からは開ける（短貸返却）', async ({ browser }) => {
    test.skip(!oldLoanReturn, 'シードが失敗している')
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-returns`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(oldLoanReturn!.lot)).toHaveCount(0)

    await page.goto(`/facilities/${fixtures!.facilityAId}/lot-search`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('ロット番号').fill(oldLoanReturn!.lot)
    await page.getByRole('button', { name: '検索する' }).click()
    await page.waitForLoadState('networkidle')

    const row = page.getByRole('row', { name: new RegExp(oldLoanReturn!.lot) })
    await expect(row).toBeVisible()
    await row.getByRole('link', { name: '詳細を見る' }).click()

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns/[^/]+$`))
    await expect(page.getByText(oldLoanReturn!.lot, { exact: true })).toBeVisible()

    await context.close()
  })
})
