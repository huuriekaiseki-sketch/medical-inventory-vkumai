import { test, expect } from '@playwright/test'

const pages = [
  { name: 'デバイス一覧', path: '/products' },
  { name: 'カテゴリ一覧', path: '/categories' },
  { name: '施設一覧', path: '/facilities' },
  { name: '販売店製品一覧', path: '/distributor-products' },
  { name: '病院価格一覧', path: '/hospital-prices' },
  { name: 'ニュース', path: '/news' },
  { name: 'その他', path: '/other' },
]

test.describe('ページスモークテスト', () => {
  for (const { name, path } of pages) {
    test(`${name}（${path}）が開いてクラッシュしない`, async ({ page }) => {
      const consoleErrors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text())
      })

      await page.goto(path)
      await page.waitForLoadState('networkidle')
      await expect(page.locator('h1')).toBeVisible()
      expect(consoleErrors).toHaveLength(0)
    })
  }
})

test('未認証でアクセスすると /login にリダイレクトされる', async ({ browser }) => {
  // storageState を使わない新しいコンテキストで確認
  const context = await browser.newContext({ storageState: undefined }) // グローバル設定を継承しない
  const page = await context.newPage()
  await page.goto('/facilities')
  await expect(page).toHaveURL(/\/login/)
  await context.close()
})

test('認証済みでヘッダーのログアウトボタンをクリックすると /login に遷移し、再アクセスで未認証扱いになる', async ({ page }) => {
  await page.goto('/facilities')
  await expect(page.getByRole('button', { name: 'ログアウト' })).toBeVisible()

  await page.getByRole('button', { name: 'ログアウト' }).click()
  await expect(page).toHaveURL(/\/login/)

  // ログアウト後は保護ページへ再アクセスすると未認証としてリダイレクトされる
  await page.goto('/facilities')
  await expect(page).toHaveURL(/\/login/)
})
