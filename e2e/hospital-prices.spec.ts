import { test, expect, type Page } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY: 院内価格は E2E が 1 本も無い最後の主要フローだった。
//      「施設 × 代理店商品」に付く値で、**同じ組み合わせは 1 件だけ**（UNIQUE）、
//      値を変えると価格履歴が残り、消すと履歴も一緒に消える
//      （20260906000007。孤児になっていた実害を塞いだ migration）。
//      画面から通しで測るのはここが初めて。
//
//      **ここで測らないこと**: 楽観ロックの競合（P-052）。ブラウザ 1 つでは同時更新を作れないので、
//      `supabase/__tests__/integration/hospital-prices-concurrency.integration.test.ts` が見る。

const fixtures = readCrossFacilityFixtures()

function uniquePrice() {
  // 一覧は円をカンマ区切りで出すので、桁が変わらない範囲で一意にする
  return 100000 + Math.floor(Math.random() * 899999)
}

/** 施設 A の院内価格一覧を開く */
async function openList(page: Page) {
  await page.goto(`/hospital-prices?facilityId=${fixtures!.facilityAId}`)
  await page.waitForLoadState('networkidle')
}

/** 新規登録フォームを埋めて送り、POST の応答を返す */
async function createPrice(page: Page, purchase: number, delivery: number) {
  await page.goto('/hospital-prices/new')
  await page.waitForLoadState('networkidle')
  await page.getByLabel('施設').selectOption({ label: fixtures!.facilityAName! })
  await page.getByLabel('代理店商品').selectOption({ label: fixtures!.distributorProductName! })
  await page.getByLabel('仕切値（円）').fill(String(purchase))
  await page.getByLabel('納品価格（円）').fill(String(delivery))
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/hospital-prices') && res.request().method() === 'POST'
    ),
    page.getByRole('button', { name: '登録' }).click(),
  ])
  return response
}

/** 施設 A の院内価格を service role 相当（ユーザー A の API）で全部消す。テスト間の独立を保つ */
async function clearPrices(page: Page) {
  const res = await page.request.get(`/api/hospital-prices?facilityId=${fixtures!.facilityAId}`)
  if (!res.ok()) return
  const body = await res.json()
  for (const price of body.prices ?? []) {
    await page.request.delete(`/api/hospital-prices/${price.id}`)
  }
}

test.describe('院内価格（画面から）', () => {
  test.skip(!fixtures?.distributorProductId, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  // WHY(毎回消す): 「施設 × 代理店商品」は UNIQUE なので、前のテストが残した行があると
  //      次のテストの登録が 409 になる。テストの並びに依存させない
  test.beforeEach(async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    await clearPrices(page)
    await context.close()
  })

  test('登録した院内価格が一覧に出て、粗利が計算される', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const purchase = uniquePrice()
    const delivery = purchase + 50000

    const response = await createPrice(page, purchase, delivery)
    expect(
      response.status(),
      `POST /api/hospital-prices failed (${response.status()}): ${await response.text()}`
    ).toBe(201)

    await openList(page)
    const row = page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })
    await expect(row).toBeVisible()
    await expect(row.getByText(purchase.toLocaleString(), { exact: true })).toBeVisible()
    await expect(row.getByText(delivery.toLocaleString(), { exact: true })).toBeVisible()
    // 粗利 = 納品価格 − 仕切値。画面が計算して出す
    await expect(row.getByText((delivery - purchase).toLocaleString(), { exact: true })).toBeVisible()

    await context.close()
  })

  test('同じ施設 × 同じ代理店商品を 2 回登録すると 409 で、既に登録済みだと伝わる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    expect((await createPrice(page, uniquePrice(), uniquePrice())).status()).toBe(201)

    const second = await createPrice(page, uniquePrice(), uniquePrice())
    expect(
      second.status(),
      `期待は 409、実際は ${second.status()}: ${await second.text()}`
    ).toBe(409)
    // 画面はフォームに留まり、理由が出る
    // WHY: 文言はページ側（NewHospitalPricePage）が 409 を見て出す。form の submitError とは別の場所
    await expect(page).toHaveURL(/\/hospital-prices\/new$/)
    await expect(page.getByText('この施設と商品の組み合わせは既に登録されています')).toBeVisible()

    await context.close()
  })

  test('編集で価格を変えると一覧に反映される', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const before = uniquePrice()
    expect((await createPrice(page, before, before + 10000)).status()).toBe(201)

    await openList(page)
    const row = page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })
    await row.getByRole('button', { name: '編集' }).click()
    await expect(page).toHaveURL(/\/hospital-prices\/.+\/edit/)
    await page.waitForLoadState('networkidle')

    const after = before + 123456
    await page.getByLabel('仕切値（円）').fill(String(after))
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/hospital-prices/') && res.request().method() === 'PUT'
      ),
      page.getByRole('button', { name: '更新' }).click(),
    ])
    expect(
      response.status(),
      `PUT /api/hospital-prices failed (${response.status()}): ${await response.text()}`
    ).toBe(200)

    await openList(page)
    const updated = page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })
    await expect(updated.getByText(after.toLocaleString(), { exact: true })).toBeVisible()
    await expect(updated.getByText(before.toLocaleString(), { exact: true })).toHaveCount(0)

    await context.close()
  })

  test('削除すると一覧から消える', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    expect((await createPrice(page, uniquePrice(), uniquePrice())).status()).toBe(201)

    await openList(page)
    await expect(page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })).toBeVisible()

    // 確認ダイアログが出る実装なら受ける
    page.on('dialog', (d) => d.accept())
    const [response] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/hospital-prices/') && res.request().method() === 'DELETE'
      ),
      page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })
        .getByRole('button', { name: '削除' })
        .click(),
    ])
    expect(
      response.status(),
      `DELETE /api/hospital-prices failed (${response.status()}): ${await response.text()}`
    ).toBe(200)

    await openList(page)
    await expect(page.getByRole('row', { name: new RegExp(fixtures!.distributorProductName!) })).toHaveCount(0)

    await context.close()
  })
})

test.describe('院内価格の施設間境界（P-017）', () => {
  test.skip(!fixtures?.distributorProductId, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('ユーザーBには施設Aの院内価格が存在しないように見える（読めず・更新できず・消せない）', async ({ browser }) => {
    // 施設 A に 1 件作る
    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    await clearPrices(pageA)
    const purchase = uniquePrice()
    expect((await createPrice(pageA, purchase, purchase + 20000)).status()).toBe(201)
    const listRes = await pageA.request.get(`/api/hospital-prices?facilityId=${fixtures!.facilityAId}`)
    const priceId = (await listRes.json()).prices[0].id as string
    await contextA.close()

    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })

    // WHY(3 つの動詞を全部見る): 読みだけ塞いで書きが空いている、という形が起こりうる。
    //      GET / PUT / DELETE を同じ id に対して順に叩く。
    //
    // WHY(403 ではなく 404 を期待する): route は先に `getHospitalPrice` を呼び、
    //      それは**利用者自身のクライアント**で引く（RLS が効く）。施設 B の利用者からは
    //      行が見えないので `null` になり、認可判定に届く前に 404 になる。
    //      **これは 403 より安全**で、403 だと「その id の行は存在する」と教えてしまう。
    //      route に残っている 403 の分岐は 2 枚目の防御（RLS が行を通す経路、たとえば
    //      別施設の admin）のためのもの。**404 を 403 に「直す」のは改悪**。
    const NOT_FOUND = 404
    const get = await contextB.request.get(`/api/hospital-prices/${priceId}`)
    expect(get.status(), '他施設の院内価格が読めてしまった').toBe(NOT_FOUND)
    expect(await get.text(), '応答に施設 A の価格が入っている').not.toContain(String(purchase))

    const put = await contextB.request.put(`/api/hospital-prices/${priceId}`, {
      data: {
        facilityId: fixtures!.facilityBId,
        distributorProductId: fixtures!.distributorProductId,
        purchasePrice: 1,
        deliveryPrice: 2,
      },
    })
    expect(put.status(), '他施設の院内価格を更新できてしまった').toBe(NOT_FOUND)

    const del = await contextB.request.delete(`/api/hospital-prices/${priceId}`)
    expect(del.status(), '他施設の院内価格を削除できてしまった').toBe(NOT_FOUND)
    await contextB.close()

    // 対で測る: 施設 A 側では今も読めて、値が変わっていない
    const contextA2 = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const still = await contextA2.request.get(`/api/hospital-prices/${priceId}`)
    expect(still.status(), '施設 A から読めなくなっている（この確認が空振りになる）').toBe(200)
    expect((await still.json()).price.purchasePrice, '他施設の PUT が通っていた').toBe(purchase)
    await contextA2.close()
  })
})
