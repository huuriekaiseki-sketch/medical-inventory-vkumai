import { test, expect, type Page } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY(issue #803): ロット検索は「症例発注」「短貸返却」という別々の親を持つ明細を横断する
//      読み取り専用の画面。単体テスト・API route テストはモックで切れているので、
//      「画面から検索した結果が、実際に登録した明細と一致し、他施設のロットは出ない」ことを
//      ここで測る。短貸返却の登録フローは loan-returns.spec.ts と同じ submitReturn を使い、
//      作成した行のロットで検索する。

const fixtures = readCrossFacilityFixtures()

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

function uniqueReturnDatetime() {
  const year = 2015 + Math.floor(Math.random() * 10)
  const month = 1 + Math.floor(Math.random() * 12)
  const day = 1 + Math.floor(Math.random() * 28)
  const hour = Math.floor(Math.random() * 24)
  const minute = Math.floor(Math.random() * 60)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${year}-${p2(month)}-${p2(day)}T${p2(hour)}:${p2(minute)}`
}

async function submitLoanReturn(page: Page, facilityId: string, jan: string, lot: string) {
  await page.goto(`/facilities/${facilityId}/loan-returns/new`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('返却日時').fill(uniqueReturnDatetime())
  await page.getByPlaceholder('JAN').first().fill(jan)
  await page.getByPlaceholder('LOT').first().fill(lot)
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/loan-returns') && res.request().method() === 'POST'
    ),
    page.getByRole('button', { name: '返却する' }).click(),
  ])
  return response
}

async function searchLot(page: Page, facilityId: string, lot: string) {
  await page.goto(`/facilities/${facilityId}/lot-search`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('ロット番号').fill(lot)
  await page.getByRole('button', { name: '検索する' }).click()
}

test.describe('ロット検索（画面から）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('登録した短貸返却の明細が、ロット番号で検索して出てくる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const lot = `LOT-E2E-${uniqueSuffix()}`

    const response = await submitLoanReturn(page, fixtures!.facilityAId, fixtures!.productJan!, lot)
    expect(response.status(), `POST /api/loan-returns failed (${response.status()}): ${await response.text()}`).toBe(201)

    await searchLot(page, fixtures!.facilityAId, lot)

    await expect(page.getByText(lot, { exact: true })).toBeVisible()
    await expect(page.getByText('短貸返却', { exact: true })).toBeVisible()

    await context.close()
  })

  test('該当しないロットで検索すると「見つかりませんでした」が出る', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await searchLot(page, fixtures!.facilityAId, `LOT-E2E-NOT-FOUND-${uniqueSuffix()}`)

    await expect(page.getByText('該当するロットは見つかりませんでした')).toBeVisible()

    await context.close()
  })

  test('101字以上のロットでは検索が実行されず、入力エラーが表示される', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    let requested = false
    page.on('request', (req) => {
      if (req.url().includes('/api/') && req.url().includes('lot-search')) requested = true
    })

    await searchLot(page, fixtures!.facilityAId, '1'.repeat(101))
    await page.waitForTimeout(500)

    expect(requested, '101字でも検索APIが呼ばれた').toBe(false)
    await expect(page.getByText('1〜100字で入力してください')).toBeVisible()

    await context.close()
  })

  test('「短貸発注の明細は対象外」の案内が画面に出る', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/lot-search`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText('短貸発注の明細（ロット番号を記録していません）は対象外です。')).toBeVisible()

    await context.close()
  })
})

test.describe('ロット検索の施設間境界（P-013 P-017）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('ユーザーAが施設Aで登録したロットは、ユーザーBの施設B検索には出ない', async ({ browser }) => {
    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    const lot = `LOT-E2E-CROSS-${uniqueSuffix()}`

    const response = await submitLoanReturn(pageA, fixtures!.facilityAId, fixtures!.productJan!, lot)
    expect(response.status()).toBe(201)
    await contextA.close()

    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const pageB = await contextB.newPage()
    await searchLot(pageB, fixtures!.facilityBId, lot)

    await expect(pageB.getByText('該当するロットは見つかりませんでした')).toBeVisible()
    await expect(pageB.getByText(lot, { exact: true })).not.toBeVisible()

    await contextB.close()
  })
})
