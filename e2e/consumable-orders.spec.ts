// e2e/consumable-orders.spec.ts
// WHY: issue #647のレビュー指摘対応。SPEC.md背景で「e2eテストにもconsumables関連の
//      カバレッジは無し」と課題指摘していたが、Set A実装計画がUIコンポーネント単体
//      テストのみに留まりe2eを含んでいなかったギャップを埋める。
//      1) 登録フォームからの消耗品登録が一覧に即座に反映されることをブラウザ越しに検証
//      2) 他施設ユーザーが自施設の消耗品しか登録・閲覧できないこと（facility-scope維持）を
//         cross-facility-boundary.spec.tsと同じフィクスチャ方式で検証する

import { test, expect, type Page } from '@playwright/test'
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
    // WHY: page全体を対象にすると、headerのロゴリンク（href="/"）が「表示テキストを持つ
    // 最初のリンク」として先に一致してしまい、facilityIdがJSのundefinedになって
    // /facilities/undefined/... へ遷移する不具合があった（issue #669）。
    // 施設一覧の行リンクは<main>内にしか存在しないため、mainに限定して確実に一覧行を拾う。
    const firstFacilityLink = page.locator('main').getByRole('link').filter({ hasText: /./ }).first()
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
    const href = await page.locator('main').getByRole('link').filter({ hasText: /./ }).first().getAttribute('href')
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
    // requireFacilityAccess が403を返し、一覧取得が失敗表示になることを確認する。
    // WHY: 発注履歴側は「一覧の取得に失敗しました」、消耗品側は「消耗品一覧の取得に失敗しました」で
    // 後者が前者を部分文字列として含むため、getByText(exact指定なし)だと2要素にマッチして
    // strict mode violationになる（issue #669）。両方が独立した防御として効いていることを
    // exact指定でそれぞれ検証する。
    await expect(page.getByText('一覧の取得に失敗しました', { exact: true })).toBeVisible()
    await expect(page.getByText('消耗品一覧の取得に失敗しました', { exact: true })).toBeVisible()

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

// WHY(E-057、2026-09-09): 消耗品は**作成と一覧しかできなかった**。
//      打ち間違えた名前を直せず、廃番になっても発注の選択肢に残り続けた。
//      DB は施設の writer に UPDATE / DELETE を許していたので、層が食い違っていた。
//      ここでは**画面から通しで**「直す」「消す」「止める」を動かし、
//      止めたものが発注の選択肢から消えることまで確かめる（止めた意味があるか）。
test.describe('消耗品を直す・止める・消す（E-057）', () => {
  const fixtures = readCrossFacilityFixtures()
  test.skip(!fixtures, 'cross-facilityフィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY等が未設定）')

  /** 施設 A に消耗品を 1 件登録して、その品名を返す */
  async function register(page: Page, label: string) {
    const name = `${label}-${uniqueSuffix()}`
    await page.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('品名').fill(name)
    await page.getByLabel('用途').fill('ABL')
    const [res] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/consumables') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '登録する' }).click(),
    ])
    expect(res.ok(), `登録に失敗 (${res.status()}): ${await res.text()}`).toBe(true)
    await expect(page.getByText(name)).toBeVisible()
    return name
  }

  /** 品名で 1 行に絞る（画面全体から役割で引くと、他の行のボタンに当たる） */
  function row(page: Page, name: string) {
    return page.locator('li').filter({ hasText: name })
  }

  test('打ち間違えた品名を編集して直せる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const name = await register(page, 'E2E編集前')
    const renamed = `${name}-直した`

    // WHY(先に行の id を取る): 編集を押すと品名は入力欄の**値**になり、
    //      行のテキストから消える。品名で絞る書き方のままだと行を見失う（実測で失敗した）
    const testId = await row(page, name).getAttribute('data-testid')
    expect(testId, '行に data-testid が無い').toBeTruthy()
    const editing = page.getByTestId(testId!)

    await editing.getByRole('button', { name: '編集' }).click()
    await editing.getByLabel('品名').fill(renamed)
    const [res] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/consumables/') && r.request().method() === 'PUT'),
      editing.getByRole('button', { name: '保存' }).click(),
    ])
    expect(res.ok(), `更新に失敗 (${res.status()}): ${await res.text()}`).toBe(true)

    await expect(page.getByText(renamed)).toBeVisible()
    await context.close()
  })

  test('発注で使っていない消耗品は削除できる（確認してから消える）', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const name = await register(page, 'E2E削除する')

    page.on('dialog', d => d.accept())
    const [res] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/consumables/') && r.request().method() === 'DELETE'),
      row(page, name).getByRole('button', { name: '削除' }).click(),
    ])
    expect(res.ok(), `削除に失敗 (${res.status()}): ${await res.text()}`).toBe(true)

    await expect(page.getByText(name)).toHaveCount(0)
    await context.close()
  })

  test('発注で使った消耗品は消せず、使用停止にすると発注の選択肢から消える', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    // WHY(品名に「使用停止」を入れない): 行の中で `getByText('使用停止')` を使うので、
    //      品名がその語を含むと印とぶつかる（実測で strict mode violation になった）
    const name = await register(page, 'E2E廃番になった品目')

    // 発注に使う（これで削除できなくなる）
    await page.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders/new`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel(name).check()
    await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/consumable-orders') && r.request().method() === 'POST'),
      page.getByRole('button', { name: '発注する' }).click(),
    ])

    await page.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders`)
    await page.waitForLoadState('networkidle')

    // WHY(押す前に分かる): 使われているので「削除」は出さず「使用停止」だけを出す
    await expect(row(page, name).getByRole('button', { name: '使用停止' })).toBeVisible()
    await expect(row(page, name).getByRole('button', { name: '削除' })).toHaveCount(0)

    page.on('dialog', d => d.accept())
    const [res] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/consumables/') && r.request().method() === 'PATCH'),
      row(page, name).getByRole('button', { name: '使用停止' }).click(),
    ])
    expect(res.ok(), `使用停止に失敗 (${res.status()}): ${await res.text()}`).toBe(true)

    // 一覧には「使用停止」として残る（過去の発注が読めなくならないように行は消さない）
    await expect(row(page, name).getByText('使用停止', { exact: true })).toBeVisible()
    // 止めたら直す・止めるボタンは出ない
    await expect(row(page, name).getByRole('button', { name: '編集' })).toHaveCount(0)

    // **止めた意味があるか**: 発注の選択肢から消えている
    await page.goto(`/facilities/${fixtures!.facilityAId}/consumable-orders/new`)
    await page.waitForLoadState('networkidle')
    await expect(page.getByText(name)).toHaveCount(0)

    await context.close()
  })
})
