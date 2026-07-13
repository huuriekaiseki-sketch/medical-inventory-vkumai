import { test, expect } from '@playwright/test'

test.describe('デバイス（製品）管理', () => {
  test('一覧に「製品名」「メーカー名」列が表示される', async ({ page }) => {
    await page.goto('/products')
    await expect(page.getByRole('columnheader', { name: '製品名' })).toBeVisible()
    await expect(page.getByRole('columnheader', { name: 'メーカー名' })).toBeVisible()
  })

  test('新規登録した製品が一覧に反映される', async ({ page }) => {
    const uniqueSuffix = Math.random().toString(36).slice(2, 8)
    const jan = `490${uniqueSuffix.padEnd(10, '0')}`.slice(0, 13)
    const name = `E2Eテスト製品-${uniqueSuffix}`
    const maker = `E2Eテストメーカー-${uniqueSuffix}`

    await page.goto('/products')
    await page.getByRole('button', { name: '+ 新規登録' }).click()
    await expect(page).toHaveURL(/\/products\/new/)

    await page.getByLabel('JAN コード').fill(jan)
    await page.getByLabel('REF コード').fill(`REF-${uniqueSuffix}`)
    await page.getByLabel('製品名').fill(name)
    await page.getByLabel('メーカー名').fill(maker)
    await page.getByRole('button', { name: '登録' }).click()

    await expect(page).toHaveURL(/\/products$/)
    await expect(page.getByRole('cell', { name, exact: true })).toBeVisible()
    await expect(page.getByRole('cell', { name: maker, exact: true })).toBeVisible()
  })

  test('編集で製品名を変更すると一覧に反映される', async ({ page }) => {
    const uniqueSuffix = Math.random().toString(36).slice(2, 8)
    const jan = `491${uniqueSuffix.padEnd(10, '0')}`.slice(0, 13)
    const originalName = `E2E編集前-${uniqueSuffix}`
    const updatedName = `E2E編集後-${uniqueSuffix}`

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(jan)
    await page.getByLabel('REF コード').fill(`REF-EDIT-${uniqueSuffix}`)
    await page.getByLabel('製品名').fill(originalName)
    await page.getByRole('button', { name: '登録' }).click()
    await expect(page).toHaveURL(/\/products$/)

    const row = page.getByRole('row', { name: new RegExp(originalName) })
    await row.getByRole('button', { name: '編集' }).click()
    await expect(page).toHaveURL(/\/products\/.+\/edit/)

    const nameInput = page.getByLabel('製品名')
    await expect(nameInput).toHaveValue(originalName)
    await nameInput.fill(updatedName)
    await page.getByRole('button', { name: '保存' }).click()

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
    const uniqueSuffix = Math.random().toString(36).slice(2, 8)
    const jan = `492${uniqueSuffix.padEnd(10, '0')}`.slice(0, 13)
    const name = `E2Eメーカー無し-${uniqueSuffix}`

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(jan)
    await page.getByLabel('REF コード').fill(`REF-NOMAKER-${uniqueSuffix}`)
    await page.getByLabel('製品名').fill(name)
    await page.getByRole('button', { name: '登録' }).click()

    await expect(page).toHaveURL(/\/products$/)
    const row = page.getByRole('row', { name: new RegExp(name) })
    await expect(row.getByRole('cell', { name: '—', exact: true })).toBeVisible()
  })
})
