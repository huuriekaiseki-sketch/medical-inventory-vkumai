import { test, expect, type Page } from '@playwright/test'
import limitsConfig from '../aidd.config.json'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY: 症例発注は**患者 ID・イニシャル・性別・担当医**を扱う唯一のフローで、
//      壊れ方の影響がいちばん大きいのに E2E が 1 本も無かった。
//
//      2026-09-08 に短貸返却で見つけた 3 件（未登録 JAN の 500 / 日時の 9 時間ずれ /
//      作成＝確定）はどれも**共通の場所**で直したが、**画面から測ったのは返却だけ**だった。
//      同じ入口が症例発注にもあるので、ここで「共通の修正が画面まで届いているか」を確かめる。
//        - E-050 … 未登録の JAN で 400 と「どの JAN が悪いか」が返る
//        - E-051 … 入力した症例日時がそのまま一覧に返る
//        - E-052 … 作られた発注が「提出済」になっている（下書きのまま止まらない）
//      あわせて、**他施設からは患者情報が 1 文字も見えない**ことを測る（#757 の 5）。

const JAN_LIMIT = limitsConfig.limits.textLength.janOrRef

const fixtures = readCrossFacilityFixtures()

function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0')
}

/**
 * 実行ごとに違う症例日時を作る。
 *
 * WHY(入力した壁時計をそのまま期待する): 利用者は JST の壁時計を入力し、
 *      一覧は Asia/Tokyo 固定で整形する。ずれていれば `jstLocalInputToIso` が効いていない。
 */
function uniqueCaseDatetime() {
  const year = 2015 + Math.floor(Math.random() * 10)
  const month = 1 + Math.floor(Math.random() * 12)
  const day = 1 + Math.floor(Math.random() * 28)
  const hour = Math.floor(Math.random() * 24)
  const minute = Math.floor(Math.random() * 60)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return {
    input: `${year}-${p2(month)}-${p2(day)}T${p2(hour)}:${p2(minute)}`,
    jstDisplay: `${year}/${month}/${day} ${hour}:${p2(minute)}:00`,
  }
}

type CaseOrderForm = {
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  doctorName: string
  jan: string
}

/** 症例発注のフォームを埋めて送り、POST の応答を返す */
async function submitCaseOrder(page: Page, facilityId: string, form: CaseOrderForm) {
  await page.goto(`/facilities/${facilityId}/case-orders/new`)
  await page.waitForLoadState('networkidle')
  await page.getByLabel('症例日時').fill(form.caseDatetime)
  await page.getByLabel('手技名').fill(form.procedureName)
  await page.getByLabel('患者ID').fill(form.patientId)
  await page.getByLabel('患者イニシャル').fill(form.patientInitials)
  await page.getByLabel('担当医師').fill(form.doctorName)
  await page.getByPlaceholder('JAN').first().fill(form.jan)
  const [response] = await Promise.all([
    page.waitForResponse(
      (res) => res.url().includes('/api/case-orders') && res.request().method() === 'POST'
    ),
    page.getByRole('button', { name: '発注する' }).click(),
  ])
  return response
}

function makeForm(suffix: string, overrides: Partial<CaseOrderForm> = {}): CaseOrderForm {
  return {
    caseDatetime: uniqueCaseDatetime().input,
    procedureName: `E2E症例手技-${suffix}`,
    patientId: `PT-E2E-${suffix}`,
    patientInitials: 'T.E.',
    doctorName: `E2E医師-${suffix}`,
    jan: fixtures!.productJan!,
    ...overrides,
  }
}

test.describe('症例発注（画面から）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('登録した症例発注が一覧に出て、症例日時はそのまま・状態は提出済になる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()
    const when = uniqueCaseDatetime()
    const form = makeForm(suffix, { caseDatetime: when.input })

    const response = await submitCaseOrder(page, fixtures!.facilityAId, form)
    expect(
      response.status(),
      `POST /api/case-orders failed (${response.status()}): ${await response.text()}`
    ).toBe(201)

    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders$`))
    await page.waitForLoadState('networkidle')

    const row = page.getByRole('row', { name: new RegExp(form.procedureName) })
    await expect(row).toBeVisible()
    // E-051: 入れた壁時計がそのまま返る
    await expect(row.getByText(when.jstDisplay, { exact: true })).toBeVisible()
    // E-052: 作成＝確定。下書きのまま止まらない
    await expect(row.getByText('提出済', { exact: true })).toBeVisible()

    await context.close()
  })

  test('製品マスタに無い JAN は 400 で止まり、どの JAN が悪いかが伝わる', async ({ browser }) => {
    // WHY: E-050 の修正は repository 層（共通）に入れた。症例発注の画面からも届いているかを見る
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()
    const unknownJan = `e2e-case-unknown-${suffix}`

    const response = await submitCaseOrder(page, fixtures!.facilityAId, makeForm(suffix, { jan: unknownJan }))

    expect(
      response.status(),
      `期待は 400、実際は ${response.status()}: ${await response.text()}`
    ).toBe(400)
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/new$`))
    await expect(page.getByText('製品マスタに登録されていない JAN です')).toBeVisible()
    await expect(page.getByText(unknownJan)).toBeVisible()

    await context.close()
  })

  test(`明細の JAN が上限（${JAN_LIMIT}）を超えると 400 で止まり、何文字までかが伝わる`, async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()

    const response = await submitCaseOrder(page, fixtures!.facilityAId, makeForm(suffix, { jan: '4'.repeat(JAN_LIMIT + 1) }))

    expect(response.status()).toBe(400)
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/new$`))
    await expect(page.getByText(`${JAN_LIMIT} 文字以内`)).toBeVisible()

    await context.close()
  })

  test('症例日時が空だと 400 で、何が足りないかが伝わる', async ({ browser }) => {
    // WHY: 画面は `*` を出しているだけで required 属性が無く、止めるのは API だけ。
    //      その API の文言が利用者に届くことを確かめる（届かないと「送信に失敗しました」で終わる）
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    const suffix = uniqueSuffix()

    const response = await submitCaseOrder(page, fixtures!.facilityAId, makeForm(suffix, { caseDatetime: '' }))

    expect(response.status()).toBe(400)
    await expect(page).toHaveURL(new RegExp(`/facilities/${fixtures!.facilityAId}/case-orders/new$`))
    await expect(page.getByText('症例日時は必須です')).toBeVisible()

    await context.close()
  })

  test('手技名が空だと送信されない（画面が止める）', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()

    await page.goto(`/facilities/${fixtures!.facilityAId}/case-orders/new`)
    await page.waitForLoadState('networkidle')

    let posted = false
    page.on('request', (req) => {
      if (req.url().includes('/api/case-orders') && req.method() === 'POST') posted = true
    })
    await page.getByRole('button', { name: '発注する' }).click()
    await page.waitForTimeout(1000)

    expect(posted, '手技名が空でも POST が飛んだ').toBe(false)
    await expect(page.getByText('手技名を入力してください')).toBeVisible()

    await context.close()
  })
})

test.describe('症例発注の患者情報は施設の外に出ない（P-017・#757 の 5）', () => {
  test.skip(!fixtures?.productJan, 'cross-facility フィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY 等が未設定）')

  test('ユーザーBが施設Aの症例発注一覧を開いても、患者情報は 1 文字も出ない', async ({ browser }) => {
    const suffix = uniqueSuffix()
    const form = makeForm(suffix)

    // 施設 A で 1 件作る
    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    const response = await submitCaseOrder(pageA, fixtures!.facilityAId, form)
    expect(
      response.status(),
      `POST /api/case-orders failed (${response.status()}): ${await response.text()}`
    ).toBe(201)
    await contextA.close()

    // 施設 B のユーザーが施設 A の一覧を開く
    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const pageB = await contextB.newPage()
    await pageB.goto(`/facilities/${fixtures!.facilityAId}/case-orders`)
    await pageB.waitForLoadState('networkidle')

    await expect(pageB.getByText('一覧の取得に失敗しました', { exact: true })).toBeVisible()

    // WHY(HTML 全体を見る): 画面に描かれていなくても、埋め込まれた JSON に混ざっていれば漏れている。
    //      患者 ID・イニシャル・医師名・手技名のどれ 1 つも出てはいけない
    const html = await pageB.content()
    for (const secret of [form.patientId, form.doctorName, form.procedureName]) {
      expect(html, `施設 B の画面に施設 A の患者情報が出ている: ${secret}`).not.toContain(secret)
    }

    await contextB.close()
  })

  test('自施設では患者情報が返り、ユーザーBが直接叩くと返らない（対で測る）', async ({ browser }) => {
    // WHY: 画面を経由しない直接攻撃。api-cross-facility-attack.spec.ts は route × メソッドを
    //      総当たりするが、**返ってきた本文に患者情報が入っていないか**までは見ていない
    const suffix = uniqueSuffix()
    const form = makeForm(suffix)

    const contextA = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const pageA = await contextA.newPage()
    expect((await submitCaseOrder(pageA, fixtures!.facilityAId, form)).status()).toBe(201)
    await contextA.close()

    // WHY(対で測る): 「出てこない」だけを見ると、そもそも保存できていない場合も通ってしまう。
    //      **自施設からは出てくる**ことを先に確かめてから、他施設で出ないことを見る
    const contextA2 = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const own = await contextA2.request.get(`/api/case-orders?facility_id=${fixtures!.facilityAId}`)
    expect(own.status(), '自施設の症例発注が読めない（この後の「見えない」が空振りになる）').toBe(200)
    const ownBody = await own.text()
    for (const value of [form.patientId, form.doctorName, form.procedureName]) {
      expect(ownBody, `自施設の応答に入っているはずの値が無い: ${value}`).toContain(value)
    }
    await contextA2.close()

    const contextB = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const res = await contextB.request.get(`/api/case-orders?facility_id=${fixtures!.facilityAId}`)
    expect(res.status(), '他施設の症例発注が読めてしまった').toBe(403)
    const body = await res.text()
    for (const secret of [form.patientId, form.doctorName, form.procedureName]) {
      expect(body, `応答に施設 A の患者情報が入っている: ${secret}`).not.toContain(secret)
    }
    await contextB.close()
  })
})
