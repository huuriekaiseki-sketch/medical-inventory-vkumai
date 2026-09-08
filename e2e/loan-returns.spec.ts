import { test, expect, type Page } from '@playwright/test'
import limitsConfig from '../aidd.config.json'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY: 短貸返却は業務ロジックが最も厚い流れ（原子的 RPC・製品マスタへの外部キー・施設境界・
//      文字数の上限・タイムゾーン）なのに、**E2E が 1 本も無かった**。単体テストは経路ごとに
//      モックで切れているので、「画面から入れたものが DB を通って一覧に戻ってくる」ことは
//      誰も測っていなかった。実際、この spec を書いた 2026-09-08 に実害が 2 件出た:
//        - 未登録の JAN を入れると 500「返却に失敗しました」（原因は `loan_return_items_jan_fkey`）
//        - 入れた返却日時が 9 時間ずれて表示される（datetime-local を UTC として保存していた）
//      どちらもここで固定する。
//
//      「未返却」まわり（E-052）は 2026-09-08 に **作成＝確定** と決めて塞いだ。
//      発注・返却の RPC が submitted / returned で作るようになったので、
//      バッジ・返却フォームの対象選択・ダッシュボードの件数が画面から到達できる。
//      **その通し（発注 → 未返却 → 対象を選んで返却 → 反映）を最後の describe で測る。**
//
//      2026-09-08 に**分割返却**も入れた（20260908030000）。対象の短貸発注を選ぶと明細と残数が並び、
//      行ごとに返す数量を入れる。借りた数を超える返却は DB のトリガーが拒否する（I-063 / P-050）。

const JAN_LIMIT = limitsConfig.limits.textLength.janOrRef

const fixtures = readCrossFacilityFixtures()

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/**
 * 実行ごとに違う返却日時を作る。
 *
 * WHY(一覧に出る列で探す): 短貸返却の一覧は返却日時・ステータス・作成日しか出さない
 *      （明細の JAN は出ない）。行を特定できる手掛かりが返却日時しかないので、
 *      衝突しないよう過去 10 年の範囲でランダムに選ぶ。
 * WHY(入力した壁時計をそのまま期待する): 利用者は JST の壁時計を入力する。
 *      画面は Asia/Tokyo 固定で整形する（src/lib/format-date.ts）ので、
 *      入れた時刻がそのまま返ってくるのが正しい。ずれていれば
 *      `jstLocalInputToIso` が効いていない（2026-09-08 に実測で見つけた形）。
 */
function uniqueReturnDatetime() {
  const year = 2015 + Math.floor(Math.random() * 10)
  const month = 1 + Math.floor(Math.random() * 12)
  const day = 1 + Math.floor(Math.random() * 28)
  const hour = Math.floor(Math.random() * 24)
  const minute = Math.floor(Math.random() * 60)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return {
    // <input type="datetime-local"> が受ける形
    input: `${year}-${p2(month)}-${p2(day)}T${p2(hour)}:${p2(minute)}`,
    // formatJstDateTime（toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })）が出す形。0 埋めしない
    jstDisplay: `${year}/${month}/${day} ${hour}:${p2(minute)}:00`,
  }
}

async function fillFirstItemRow(page: Page, jan: string, lot = '', ubd = '') {
  await page.getByPlaceholder('JAN').first().fill(jan)
  await page.getByPlaceholder('LOT').first().fill(lot)
  await page.getByPlaceholder('UBD').first().fill(ubd)
}

/** 返却フォームを埋めて送り、POST の応答を返す */
async function submitReturn(page: Page, facilityId: string, datetimeInput: string, jan: string, lot = '') {
  await page.goto(`/facilities/${facilityId}/loan-returns/new`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('返却日時').fill(datetimeInput)
  await fillFirstItemRow(page, jan, lot)
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/loan-returns') && res.request().method() === 'POST'
    ),
    page.getByRole('button', { name: '返却する' }).click(),
  ])
  return response
}

test.describe('短貸返却（画面から）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('登録した返却が一覧に出て、入力した返却日時がそのまま返ってくる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const when = uniqueReturnDatetime()

    const response = await submitReturn(
      page,
      fixtures!.facilityAId,
      when.input,
      fixtures!.productJan!,
      `LOT-${uniqueSuffix()}`
    )
    expect(
      response.status(),
      `POST /api/loan-returns failed (${response.status()}): ${await response.text()}`
    ).toBe(201)

    // 送信後は一覧へ戻る（router.push）
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns$`))
    await page.waitForLoadState('networkidle')

    // WHY(壁時計で照合する): ここがずれていれば timestamptz への保存かタイムゾーンの扱いが誤っている
    await expect(page.getByText(when.jstDisplay, { exact: true })).toBeVisible()

    await context.close()
  })

  test('製品マスタに無い JAN は 400 で止まり、何が悪いかが利用者に伝わる', async ({ browser }) => {
    // WHY: 2026-09-08 までここは 500「返却に失敗しました」だった。
    //      明細の jan は products.jan への外部キーで、未登録だと 23503 になる。
    //      利用者が自分で直せる間違いなので 400 と「未登録である」ことを返す
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const unknownJan = `e2e-unknown-${uniqueSuffix()}`

    const response = await submitReturn(page, fixtures!.facilityAId, uniqueReturnDatetime().input, unknownJan)

    expect(
      response.status(),
      `期待は 400、実際は ${response.status()}: ${await response.text()}`
    ).toBe(400)
    // 画面に留まる ＝ 行が作られていない
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns/new$`))
    await expect(page.getByText('製品マスタに登録されていない JAN です')).toBeVisible()
    // 利用者が入れた値そのものを返す（どの JAN が悪いのか分かる）
    await expect(page.getByText(unknownJan)).toBeVisible()

    await context.close()
  })

  test(`明細の JAN が上限（${JAN_LIMIT}）を超えると 400 で止まり、何文字までかが伝わる`, async ({ browser }) => {
    // WHY: 入口の zod が外部キーより手前で弾く。上の「未登録」とは別の理由・別の文言になる
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    const response = await submitReturn(
      page,
      fixtures!.facilityAId,
      uniqueReturnDatetime().input,
      '4'.repeat(JAN_LIMIT + 1)
    )

    expect(
      response.status(),
      `期待は 400、実際は ${response.status()}: ${await response.text()}`
    ).toBe(400)
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns/new$`))
    await expect(page.getByText(`${JAN_LIMIT} 文字以内`)).toBeVisible()

    await context.close()
  })

  test('返却日時が空のままでは送信されない（必須の欄）', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-returns/new`)
    await page.waitForLoadState('networkidle')
    await fillFirstItemRow(page, fixtures!.productJan!)

    // WHY: 「送信が起きなかった」ことを確かめたいので、クリック後に少し待って POST の有無を見る
    let posted = false
    page.on('request', (req) => {
      if (req.url().includes('/api/loan-returns') && req.method() === 'POST') posted = true
    })
    await page.getByRole('button', { name: '返却する' }).click()
    await page.waitForTimeout(1000)

    expect(posted, '返却日時が空でも POST が飛んだ').toBe(false)
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/loan-returns/new$`))

    await context.close()
  })
})

test.describe('短貸返却の施設間境界（P-017）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('ユーザーBが施設Aの返却一覧を開くと取得に失敗する', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()
    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-returns`)
    await page.waitForLoadState('networkidle')

    // GET /api/loan-returns の requireFacilityAccess が 403 を返し、一覧が失敗表示になる
    await expect(page.getByText('一覧の取得に失敗しました', { exact: true })).toBeVisible()

    await context.close()
  })

  test('ユーザーAが施設Aで登録した返却は、ユーザーBの施設Bの一覧には出ない', async ({ browser }) => {
    const when = uniqueReturnDatetime()

    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    const response = await submitReturn(
      pageA,
      fixtures!.facilityAId,
      when.input,
      fixtures!.productJan!,
      `LOT-${uniqueSuffix()}`
    )
    expect(
      response.status(),
      `POST /api/loan-returns failed (${response.status()}): ${await response.text()}`
    ).toBe(201)
    await expect(pageA.getByText(when.jstDisplay, { exact: true })).toBeVisible()
    await contextA.close()

    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const pageB = await contextB.newPage()
    await pageB.goto(`/facilities/${fixtures!.facilityBId}/loan-returns`)
    await pageB.waitForLoadState('networkidle')

    await expect(pageB.getByText(when.jstDisplay, { exact: true })).not.toBeVisible()
    await contextB.close()
  })
})

test.describe('未返却の通し（発注 → 未返却 → 対象を選んで返却 → 反映）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  /** ダッシュボードで施設 A の未返却件数を読む。バッジが「未返却なし」なら 0 */
  async function readOutstanding(page: Page): Promise<number> {
    await page.goto('/')
    await page.waitForLoadState('networkidle')
    // 施設名のリンクを含むカードに絞る（他施設の行を拾わない）
    const card = page.locator('div').filter({ hasText: fixtures!.facilityAName! }).last()
    const text = await card.innerText()
    const m = /未返却\s*(\d+)\s*件/.exec(text)
    if (m) return Number(m[1])
    if (text.includes('未返却なし')) return 0
    throw new Error(`施設 A の未返却バッジが読めない:\n${text.slice(0, 400)}`)
  }

  test('発注すると未返却になり、対象を選んで返却すると解消する', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const facilityId = fixtures!.facilityAId
    const suffix = uniqueSuffix()
    const procedureName = `E2E通し術式-${suffix}`
    const maker = `E2E通しメーカー-${suffix}`
    // 一覧の「対象の短貸発注」に出るのは summary（手技名（メーカー））
    const summary = `${procedureName}（${maker}）`

    const before = await readOutstanding(page)

    // 1. 短貸発注を作る
    await page.goto(`/facilities/${facilityId}/loan-orders/new`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('手技名').fill(procedureName)
    await page.getByLabel('メーカー').fill(maker)
    await page.getByPlaceholder('JAN').first().fill(fixtures!.productJan!)
    await page.getByPlaceholder('品名').first().fill(`E2E通し品名-${suffix}`)
    const [orderRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/loan-orders') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '発注する' }).click(),
    ])
    expect(
      orderRes.status(),
      `POST /api/loan-orders failed (${orderRes.status()}): ${await orderRes.text()}`
    ).toBe(201)

    // 2. 履歴で「未返却」バッジが付く
    await page.goto(`/orders?facilityId=${facilityId}&kind=loan_order`)
    await page.waitForLoadState('networkidle')
    const orderRow = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(orderRow).toBeVisible()
    await expect(orderRow.getByText('未返却')).toBeVisible()

    // 3. ダッシュボードの件数が 1 増える
    expect(await readOutstanding(page), '発注しても未返却件数が増えない').toBe(before + 1)

    // 4. 返却フォームの「対象の短貸発注」に出る（ここが空だと E-052 の状態に戻っている）
    await page.goto(`/facilities/${facilityId}/loan-returns/new`)
    await page.waitForLoadState('networkidle')
    const select = page.getByLabel('対象の短貸発注')
    await expect(select.getByRole('option', { name: summary })).toBeAttached()

    // 5. 対象を選んで返却する（明細ごとに返す数量を入れる）
    await select.selectOption({ label: summary })
    const qty = page.getByLabel(`E2E通し品名-${suffix} の返す数`)
    await expect(qty).toBeVisible()
    await qty.fill('1')
    await page.getByLabel('返却日時').fill(uniqueReturnDatetime().input)
    const [returnRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/loan-returns') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '返却する' }).click(),
    ])
    expect(
      returnRes.status(),
      `POST /api/loan-returns failed (${returnRes.status()}): ${await returnRes.text()}`
    ).toBe(201)

    // 6. バッジが消える
    await page.goto(`/orders?facilityId=${facilityId}&kind=loan_order`)
    await page.waitForLoadState('networkidle')
    const rowAfter = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(rowAfter).toBeVisible()
    await expect(rowAfter.getByText('未返却')).toHaveCount(0)

    // 7. 件数が元に戻る
    expect(await readOutstanding(page), '返却しても未返却件数が減らない').toBe(before)

    await context.close()
  })

  test('分割して返せる。全部返すまで未返却のまま残り、残数が減る', async ({ browser }) => {
    // WHY: 2026-09-08 まで「同じ短貸発注は 2 回返却できない」だった（部分 UNIQUE）。
    //      分割して返す運用が実在するので、2 回に分けて返せることと、
    //      **途中では未返却のまま残数だけ減る**ことを画面から測る
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const facilityId = fixtures!.facilityAId
    const suffix = uniqueSuffix()
    const procedureName = `E2E分割返却術式-${suffix}`
    const maker = `E2E分割返却メーカー-${suffix}`
    const summary = `${procedureName}（${maker}）`
    const itemName = `E2E分割返却品名-${suffix}`

    // 3 本の発注を作る
    await page.goto(`/facilities/${facilityId}/loan-orders/new`)
    await page.waitForLoadState('networkidle')
    await page.getByLabel('手技名').fill(procedureName)
    await page.getByLabel('メーカー').fill(maker)
    await page.getByPlaceholder('JAN').first().fill(fixtures!.productJan!)
    await page.getByPlaceholder('品名').first().fill(itemName)
    await page.getByRole('spinbutton').first().fill('3')
    const [orderRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/loan-orders') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '発注する' }).click(),
    ])
    expect(orderRes.status(), await orderRes.text()).toBe(201)

    const returnSome = async (n: string) => {
      await page.goto(`/facilities/${facilityId}/loan-returns/new`)
      await page.waitForLoadState('networkidle')
      await page.getByLabel('対象の短貸発注').selectOption({ label: summary })
      const qty = page.getByLabel(`${itemName} の返す数`)
      await expect(qty).toBeVisible()
      await qty.fill(n)
      await page.getByLabel('返却日時').fill(uniqueReturnDatetime().input)
      const [res] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().includes('/api/loan-returns') && r.request().method() === 'POST'
        ),
        page.getByRole('button', { name: '返却する' }).click(),
      ])
      return res
    }

    // 1 回目: 1 本返す → まだ未返却、残り 2
    expect((await returnSome('1')).status()).toBe(201)
    await page.goto(`/orders?facilityId=${facilityId}&kind=loan_order`)
    await page.waitForLoadState('networkidle')
    const midRow = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(midRow.getByText('未返却 2')).toBeVisible()

    // 2 回目: 残り 2 本返す → 未返却が消える
    expect((await returnSome('2')).status()).toBe(201)
    await page.goto(`/orders?facilityId=${facilityId}&kind=loan_order`)
    await page.waitForLoadState('networkidle')
    const doneRow = page.getByRole('row', { name: new RegExp(procedureName) })
    await expect(doneRow).toBeVisible()
    await expect(doneRow.getByText(/未返却/)).toHaveCount(0)

    // 3 回目: 選択肢からも消えている（返す物が残っていない）
    await page.goto(`/facilities/${facilityId}/loan-returns/new`)
    await page.waitForLoadState('networkidle')
    await expect(
      page.getByLabel('対象の短貸発注').getByRole('option', { name: summary })
    ).toHaveCount(0)

    await context.close()
  })
})
