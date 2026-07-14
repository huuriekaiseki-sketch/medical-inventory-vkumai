import { test, expect, type Page } from '@playwright/test'

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

async function registerProduct(
  page: Page,
  data: { jan: string; ref: string; name: string; maker?: string }
) {
  await page.goto('/products/new')
  await page.getByLabel('JAN コード').fill(data.jan)
  await page.getByLabel('REF コード').fill(data.ref)
  await page.getByLabel('製品名').fill(data.name)
  if (data.maker) {
    await page.getByLabel('メーカー名').fill(data.maker)
  }

  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/products') && res.request().method() === 'POST'
    ),
    page.getByRole('button', { name: '登録' }).click(),
  ])
  expect(response.ok(), `POST /api/products failed (${response.status()}): ${await response.text()}`).toBe(true)
  await expect(page).toHaveURL(/\/products$/)
}

test.describe('デバイス（製品）管理', () => {
  test('一覧に「製品名」「メーカー名」列が表示される', async ({ page }) => {
    const suffix = uniqueSuffix()
    await registerProduct(page, {
      jan: `480${suffix}`.slice(0, 13),
      ref: `REF-COL-${suffix}`,
      name: `E2E列表示確認-${suffix}`,
    })

    await expect(page.getByRole('columnheader', { name: '製品名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'メーカー名' })).toBeVisible()
  })

  test('新規登録した製品が一覧に反映される', async ({ page }) => {
    const suffix = uniqueSuffix()
    const name = `E2Eテスト製品-${suffix}`
    const maker = `E2Eテストメーカー-${suffix}`

    await registerProduct(page, {
      jan: `490${suffix}`.slice(0, 13),
      ref: `REF-${suffix}`,
      name,
      maker,
    })

    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: maker, exact: true })).toBeVisible()
  })

  test('編集で製品名を変更すると一覧に反映される', async ({ page }) => {
    const suffix = uniqueSuffix()
    const originalName = `E2E編集前-${suffix}`
    const updatedName = `E2E編集後-${suffix}`

    await registerProduct(page, {
      jan: `491${suffix}`.slice(0, 13),
      ref: `REF-EDIT-${suffix}`,
      name: originalName,
    })

    const row = page.getByRole('row', { name: new RegExp(originalName) })
    await row.getByRole('button', { name: '編集' }).click()
    await expect(page).toHaveURL(/\/products\/.+\/edit/)

    const nameInput = page.getByLabel('製品名')
    await expect(nameInput).toHaveValue(originalName)
    await nameInput.fill(updatedName)

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products/') && res.request().method() === 'PUT'
      ),
      page.getByRole('button', { name: '更新' }).click(),
    ])
    expect(response.ok(), `PUT /api/products/[id] failed (${response.status()}): ${await response.text()}`).toBe(true)

    await expect(page).toHaveURL(/\/products$/)
    await expect(page.getByRole('cell', { name: updatedName, exact: true })).toBeVisible()
  })

  test('製品名を空欄で登録するとバリデーションエラーが表示される', async ({ page }) => {
    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill('4900000000001')
    await page.getByLabel('REF コード').fill('REF-EMPTY-NAME')
    // name は required のためネイティブバリデーションで送信がブロックされ、ページ遷移しない
    await page.getByRole('button', { name: '登録' }).click()
    await expect(page).toHaveURL(/\/products\/new/)
  })

  test('メーカー名を空欄で登録すると成功する', async ({ page }) => {
    const suffix = uniqueSuffix()
    const name = `E2Eメーカー無し-${suffix}`

    await registerProduct(page, {
      jan: `492${suffix}`.slice(0, 13),
      ref: `REF-NOMAKER-${suffix}`,
      name,
    })

    const row = page.getByRole('row', { name: new RegExp(name) })
    await expect(row.getByRole('cell', { name: '—', exact: true })).toBeVisible()
  })
})
