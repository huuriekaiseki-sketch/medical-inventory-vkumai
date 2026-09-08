import { test, expect, type Page } from '@playwright/test'
import limitsConfig from '../aidd.config.json'

// WHY: issue #757 の 20（入力の検証）。20260907060000 で `products.name` / `products.maker` に
//      上限を足したが、**画面から長い文字列を入れたときに何が起きるかを一度も測っていなかった**。
//
//      層は 3 枚ある:
//        画面   … `ProductForm` に maxLength は無い（＝**画面は止めない**）
//        API    … zod（`text-limits.ts`）が 400 と「何文字までか」を返す
//        DB     … CHECK が最後の防波堤（23514。ここまで来ると文言は利用者に伝わらない）
//      ここで確かめるのは「利用者が長い文字列を入れたとき、**API の 400 で止まり、
//      上限が文言で伝わり、行が作られない**」こと。DB の CHECK 単体は
//      `supabase/__tests__/integration/remaining-text-length-limits.integration.test.ts` が見る。
//
// WHY(上限を設定から読む): ここに 200 と書くと、設定・DB・API・E2E の 4 か所に同じ数字が散る。
//      `aidd.config.json` を唯一の出どころにする（他の層と同じ扱い）。
const LIMIT = limitsConfig.limits.textLength.productName

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/** alert() を捕まえる。画面はエラーを alert で出す（NewProductPage） */
function captureDialogs(page: Page): string[] {
  const messages: string[] = []
  page.on('dialog', async (d) => {
    messages.push(d.message())
    await d.dismiss()
  })
  return messages
}

test.describe('製品マスタの文字数の上限（画面から入れたとき）', () => {
  test(`製品名が上限（${LIMIT}）を超えると登録できず、何文字までかが伝わる`, async ({ page }) => {
    const suffix = uniqueSuffix()
    const messages = captureDialogs(page)

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(`493${suffix}`.slice(0, 13))
    await page.getByLabel('REF コード').fill(`REF-LONG-${suffix}`)
    // **画面に maxLength は無い**ので、長い文字列はそのまま送られる（画面は防御ではない）
    await page.getByLabel('製品名').fill('あ'.repeat(LIMIT + 1))

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '登録' }).click(),
    ])

    // 400 で止まる（500 や 23514 の生エラーではない）
    expect(response.status(), `期待は 400、実際は ${response.status()}: ${await response.text()}`).toBe(400)
    // 一覧へ遷移しない ＝ 行が作られていない
    await expect(page).toHaveURL(/\/products\/new$/)
    // 「何文字までか」が利用者に伝わる
    expect(messages.join('\n')).toContain(`${LIMIT} 文字以内`)
  })

  test(`製品名がちょうど上限（${LIMIT}）なら登録できる（境界の反対側）`, async ({ page }) => {
    const suffix = uniqueSuffix()
    const messages = captureDialogs(page)
    // 一覧で見つけられるよう、先頭に印を付けてちょうど上限の長さにする
    const mark = `E2E境界-${suffix}-`
    const name = mark + 'あ'.repeat(LIMIT - mark.length)
    expect(name.length).toBe(LIMIT)

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(`494${suffix}`.slice(0, 13))
    await page.getByLabel('REF コード').fill(`REF-EDGE-${suffix}`)
    await page.getByLabel('製品名').fill(name)

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '登録' }).click(),
    ])

    expect(response.ok(), `境界ちょうどが拒否された (${response.status()}): ${await response.text()}`).toBe(true)
    expect(messages, `境界ちょうどでエラーが出た: ${messages.join(' / ')}`).toEqual([])
    await expect(page).toHaveURL(/\/products$/)
  })

  test(`メーカー名が上限（${LIMIT}）を超えると登録できない（任意の欄も見る）`, async ({ page }) => {
    const suffix = uniqueSuffix()
    const messages = captureDialogs(page)

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(`495${suffix}`.slice(0, 13))
    await page.getByLabel('REF コード').fill(`REF-MAKER-${suffix}`)
    await page.getByLabel('製品名').fill(`E2Eメーカー超過-${suffix}`)
    await page.getByLabel('メーカー名').fill('あ'.repeat(LIMIT + 1))

    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '登録' }).click(),
    ])

    expect(response.status()).toBe(400)
    await expect(page).toHaveURL(/\/products\/new$/)
    expect(messages.join('\n')).toContain(`${LIMIT} 文字以内`)
  })

  test(`編集画面でも上限（${LIMIT}）を超えると保存できない`, async ({ page }) => {
    // WHY(登録だけでなく編集も見る): 入口が 2 つあるので、片方だけ守られている形が起こりうる
    const suffix = uniqueSuffix()
    const messages = captureDialogs(page)
    const name = `E2E編集上限-${suffix}`

    await page.goto('/products/new')
    await page.getByLabel('JAN コード').fill(`496${suffix}`.slice(0, 13))
    await page.getByLabel('REF コード').fill(`REF-EDITLIM-${suffix}`)
    await page.getByLabel('製品名').fill(name)
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '登録' }).click(),
    ])
    await expect(page).toHaveURL(/\/products$/)

    const row = page.getByRole('row', { name: new RegExp(name) })
    await row.getByRole('button', { name: '編集' }).click()
    await expect(page).toHaveURL(/\/products\/.+\/edit/)

    await page.getByLabel('製品名').fill('あ'.repeat(LIMIT + 1))
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/products/') && res.request().method() === 'PUT'
      ),
      page.getByRole('button', { name: '更新' }).click(),
    ])

    expect(response.status()).toBe(400)
    await expect(page).toHaveURL(/\/products\/.+\/edit/)
    expect(messages.join('\n')).toContain(`${LIMIT} 文字以内`)
  })
})
