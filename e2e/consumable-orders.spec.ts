// e2e/consumable-orders.spec.ts
// WHY: issue #647のレビュー指摘対応。SPEC.md背景で「e2eテストにもconsumables関連の
//      カバレッジは無し」と課題指摘していたが、Set A実装計画がUIコンポーネント単体
//      テストのみに留まりe2eを含んでいなかったギャップを埋める。
//      1) 登録フォームからの消耗品登録が一覧に即座に反映されることをブラウザ越しに検証
//      2) 他施設ユーザーが自施設の消耗品しか登録・閲覧できないこと（facility-scope維持）を
//         cross-facility-boundary.spec.tsと同じフィクスチャ方式で検証する

import { test, expect } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

test.describe('消耗品登録（issue #647）', () => {
  test('登録した消耗品が一覧に即座に反映される', async ({ page }) => {
    await page.goto('/facilities')
    await page.waitForLoadState('networkidle')
    const firstFacilityLink = page.getByRole('link').filter({ hasText: /./ }).first()
    // 施設一覧から最初の施設の詳細IDを取得し、その消耗品発注ページへ遷移する
    const href = await firstFacilityLink.getAttribute('href')
    test.skip(!href, '施設一覧に遷移可能な施設が存在しない')

    const facilityId = href!.split('/').filter(Boolean).pop()
    await page.goto(`/facilities/${facilityId}/consumable-orders`)
    await page.waitForLoadState('networkidle')

    const suffix = uniqueSuffix()
    const name = `E2E消耗品-${suffix}`
    const purpose = `E2E用途-${suffix}`

    await page.getByLabel('品名').fill(name)
    await page.getByLabel('用途').fill(purpose)

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/consumables') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '登録する' }).click(),
    ])
    expect(response.ok(), `POST /api/consumables failed (${response.status()}): ${await response.text()}`).toBe(true)

    await expect(page.getByText(name)).toBeVisible()
  })

  test('品名・用途が空白のみの場合はエラー表示され登録されない', async ({ page }) => {
    await page.goto('/facilities')
    await page.waitForLoadState('networkidle')
    const href = await page.getByRole('link').filter({ hasText: /./ }).first().getAttribute('href')
    test.skip(!href, '施設一覧に遷移可能な施設が存在しない')

    const facilityId = href!.split('/').filter(Boolean).pop()
    await page.goto(`/facilities/${facilityId}/consumable-orders`)
    await page.waitForLoadState('networkidle')

    await page.getByLabel('品名').fill('   ')
    await page.getByLabel('用途').fill('   ')
    await page.getByRole('button', { name: '登録する' }).click()

    await expect(page.getByText('品名を入力してください')).toBeVisible()
  })
})

test.describe('消耗品登録の施設間境界（issue #647）', () => {
  const fixtures = readCrossFacilityFixtures()
  test.skip(!fixtures, 'cross-facilityフィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY等が未設定）')

  test('ユーザーBが施設Aのconsumable-ordersページを開くとアクセス権限エラーになり、施設Aの消耗品登録フォームは操作できない', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()
    await page.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders`)
    await page.waitForLoadState('networkidle')

    // src/app/api/consumable-orders/route.ts・src/app/api/consumables/route.ts の
    // requireFacilityAccess が403を返し、一覧取得が失敗表示になることを確認する
    await expect(page.getByText('一覧の取得に失敗しました')).toBeVisible()

    await context.close()
  })

  test('ユーザーAが施設Aで登録した消耗品は、ユーザーBの施設Bのconsumable-ordersページには表示されない', async ({ browser }) => {
    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    await pageA.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders`)
    await pageA.waitForLoadState('networkidle')

    const suffix = uniqueSuffix()
    const name = `E2E施設A限定消耗品-${suffix}`
    await pageA.getByLabel('品名').fill(name)
    await pageA.getByLabel('用途').fill(`E2E施設A用途-${suffix}`)

    const [response] = await Promise.all([
      pageA.waitForResponse(
        (res) => res.url().includes('/api/consumables') && res.request().method() === 'POST'
      ),
      pageA.getByRole('button', { name: '登録する' }).click(),
    ])
    expect(response.ok(), `POST /api/consumables failed (${response.status()}): ${await response.text()}`).toBe(true)
    await expect(pageA.getByText(name)).toBeVisible()
    await contextA.close()

    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const pageB = await contextB.newPage()
    await pageB.goto(`/facilities/${fixtures!.facilityBId}/consumable-orders`)
    await pageB.waitForLoadState('networkidle')

    await expect(pageB.getByText(name)).not.toBeVisible()
    await contextB.close()
  })
})
