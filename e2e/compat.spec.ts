// e2e/compat.spec.ts
// WHY: issue #21（コンパチ（互換品）ページの実体化）SPEC.md Part2 Set G。
// 最低3シナリオ: ①一般ユーザーに「＋互換品を追加」ボタンが表示されない
// ②管理者の登録フロー ③重複登録時のエラー表示
//
// 一般ユーザー（非管理者）用の認証済みstorageStateは既存の
// cross-facility-boundary.spec.ts が使う CROSS_FACILITY_USER_B（role: 'staff'）を
// 流用する。新規に非管理者専用のauth生成処理を作らずに済み、
// 実在施設名・実在製品名も使わない（docs/agents/common.md のデータ衛生ルール準拠）。
//
// 登録フロー・重複エラーの再現には「カテゴリ内に紐づく製品が2件以上ある」状態が必要なため、
// UI操作ではなくAPI（page.request、既存storageStateのCookieをそのまま利用）で
// カテゴリ・製品・distributor_productsを直接シードしてから/compatページを操作する。

import { test, expect, type APIRequestContext } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

const fixtures = readCrossFacilityFixtures()

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

async function seedCategoryWithTwoProducts(request: APIRequestContext, suffix: string) {
  const categoryRes = await request.post('/api/categories', {
    data: { name: `E2Eコンパチカテゴリ-${suffix}` },
  })
  expect(categoryRes.ok(), `POST /api/categories failed: ${await categoryRes.text()}`).toBe(true)
  const { category } = await categoryRes.json()

  async function seedProduct(labelSuffix: string) {
    const productRes = await request.post('/api/products', {
      data: {
        jan: `49${suffix}${labelSuffix}`.slice(0, 13),
        ref: `E2E-COMPAT-REF-${suffix}-${labelSuffix}`,
        name: `E2Eコンパチ製品${labelSuffix}-${suffix}`,
        maker: `E2Eコンパチメーカー-${suffix}`,
      },
    })
    expect(productRes.ok(), `POST /api/products failed: ${await productRes.text()}`).toBe(true)
    const { product } = await productRes.json()

    const dpRes = await request.post('/api/distributor-products', {
      data: {
        productId: product.id,
        categoryId: category.id,
        maker: `E2Eコンパチメーカー-${suffix}`,
        supplier: `E2Eコンパチ卸-${suffix}`,
        name: product.name,
      },
    })
    expect(dpRes.ok(), `POST /api/distributor-products failed: ${await dpRes.text()}`).toBe(true)
    return product as { id: string; name: string; jan: string; maker: string | null }
  }

  const productA = await seedProduct('A')
  const productB = await seedProduct('B')

  return { category: category as { id: string; name: string }, productA, productB }
}

// WHY: CompatForm.tsx の productLabel() と同じフォーマットで選択肢ラベルの
// 完全一致文字列を組み立てる（Playwrightの selectOption({ label }) は
// 正規表現を受け付けずstring限定のため）。
function productOptionLabel(product: { name: string; jan: string; maker: string | null }) {
  return `${product.name}（JAN: ${product.jan}、メーカー: ${product.maker ?? '不明'}）`
}

test.describe('コンパチ（互換品）ページ（issue #21）', () => {
  test('一般ユーザーには「＋互換品を追加」ボタンが表示されない', async ({ browser }) => {
    test.skip(!fixtures, 'cross-facilityフィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY等が未設定）')

    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()
    await page.goto('/compat')
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('heading', { name: 'コンパチ' })).toBeVisible()
    await expect(page.getByRole('button', { name: '＋互換品を追加' })).not.toBeVisible()

    await context.close()
  })

  test('管理者が互換ペアを登録すると一覧に反映され、同じペアの再登録は重複エラーになる', async ({ page }) => {
    const suffix = uniqueSuffix()
    const { category, productA, productB } = await seedCategoryWithTwoProducts(page.request, suffix)

    await page.goto('/compat')
    await page.waitForLoadState('networkidle')

    await page.getByRole('button', { name: '＋互換品を追加' }).click()
    await page.getByLabel('カテゴリ', { exact: true }).selectOption({ label: category.name })

    const productASelect = page.getByLabel('製品A')
    await expect(productASelect).not.toBeDisabled({ timeout: 10_000 })

    await productASelect.selectOption({ label: productOptionLabel(productA) })
    await page.getByLabel('製品B').selectOption({ label: productOptionLabel(productB) })

    const [postRes] = await Promise.all([
      page.waitForResponse((res) => res.url().includes('/api/compat') && res.request().method() === 'POST'),
      page.getByRole('button', { name: '登録' }).click(),
    ])
    expect(postRes.ok(), `POST /api/compat failed: ${await postRes.text()}`).toBe(true)

    // 登録成功でフォームが閉じ、一覧に反映される
    await expect(page.getByLabel('カテゴリ', { exact: true })).not.toBeVisible()
    await expect(page.getByText(new RegExp(productA.name))).toBeVisible()
    await expect(page.getByText(new RegExp(productB.name))).toBeVisible()

    // ③ 同じペアを再登録すると重複エラーになる
    await page.getByRole('button', { name: '＋互換品を追加' }).click()
    await page.getByLabel('カテゴリ', { exact: true }).selectOption({ label: category.name })
    await expect(page.getByLabel('製品A')).not.toBeDisabled({ timeout: 10_000 })
    await page.getByLabel('製品A').selectOption({ label: productOptionLabel(productA) })
    await page.getByLabel('製品B').selectOption({ label: productOptionLabel(productB) })
    await page.getByRole('button', { name: '登録' }).click()

    // WHY: 製品名がフォーム内の選択肢・一覧テーブル行にも出現するため、page全体への
    // getByTextではstrict mode violationになる。エラー文言はrole="alert"の要素に
    // 限定して表示されるため、そこに絞って検証する。
    const formError = page.getByRole('alert')
    await expect(formError).toContainText('すでに登録済みです')
    await expect(formError).toContainText(productA.name)
    await expect(formError).toContainText(productB.name)
  })
})
