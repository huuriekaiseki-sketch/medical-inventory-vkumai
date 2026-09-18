import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { createClient } from '@supabase/supabase-js'
import { readCrossFacilityFixtures } from './generate-cross-facility-auth-state'

// WHY: 発注金額の集計画面（/admin/reports）は E2E に一度も出てこなかった。
//      集計は「数え方の食い違い」が出やすい場所で、今日すでに 1 件出している
//      （E-053: 未返却の件数が、一覧のバッジは紐付けベース・ダッシュボードは件数差で、
//       答えが違っていた）。
//
//      この画面の表示規則は**過去に critical のレビュー指摘を受けて作り直されている**:
//      「発注 0 件」と「発注はあるが単価データなし」を区別できず、後者を ¥0 と表示していた。
//      いま `-` / `-（金額データなし）` / `¥N` の 3 通りに分かれているが、
//      **どれも実際の発注から確かめられたことが無い**（単体テストは行データを直接与えている）。
//
//      ここでは自分専用の施設を 1 つ作り、**入れた金額がそのまま出る**ことを画面から測る。
//      共有の施設 A を使うと、並行して走る他の spec が同じ施設に発注を作るので数が動く。
//
//      **ここで測らないこと**:
//      - admin 以外が集計を呼べないこと（P-045）→ `rpc-boundary.integration.test.ts` が実 DB で見る
//      - 3 通りの表示規則そのもの → `src/components/reports/__tests__/ReportTable.test.tsx`
//        が行データを直接与えて網羅する。ここは**実際の発注から 1 本だけ通す**

const fixtures = readCrossFacilityFixtures()

/** JST の今日（YYYY-MM-DD）。集計の期間は JST の 1 日で切られる */
function jstToday(): string {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
}

function suffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`
}

/** 自分だけが使う施設を作り、admin 自身を書き手として所属させる */
async function createOwnFacility(request: APIRequestContext, name: string): Promise<string> {
  const created = await request.post('/api/facilities', { data: { name } })
  expect(created.status(), `施設の作成に失敗: ${await created.text()}`).toBe(201)
  const { facility } = await created.json()

  // WHY(自分を所属させる): 発注 RPC の認可は `is_facility_writer()` で、これは
  //      `user_facilities` をその施設について見る。**is_admin() では通らない**
  //      （マスタの書き込みとは別の判定）。所属を付けないと自分の施設にも発注できない。
  const users = await request.get('/api/admin/users')
  const { users: list } = await users.json()
  const me = list.find((u: { email: string }) => u.email === process.env.E2E_TEST_EMAIL)
  expect(me, '管理者自身が利用者一覧に見つからない').toBeTruthy()

  const linked = await request.post('/api/admin/user-facilities', {
    data: { userId: me.id, facilityId: facility.id, role: 'staff' },
  })
  expect(linked.status(), `所属の付与に失敗: ${await linked.text()}`).toBe(200)

  return facility.id as string
}

/** 施設の行を名前で引く */
function reportRow(page: Page, facilityName: string) {
  return page.getByRole('row').filter({ hasText: facilityName })
}

test.describe('発注金額の集計（画面から） [P-045]', () => {
  test.skip(!fixtures?.productJan || !fixtures?.distributorProductId, 'cross-facility フィクスチャが生成されていない')
  test.skip(!process.env.E2E_TEST_EMAIL, 'E2E_TEST_EMAIL が未設定')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（後始末ができない）')

  const created: string[] = []

  // WHY(必ず消す): 施設は集計画面の**全行**に出るので、残すと次から表が伸び続ける。
  //      施設の削除は明細まで連鎖する（facility-delete-cascade で実測済み）。
  // WHY(service_role で消す): **アプリの経路では施設を消せない。**
  //      `facilities` には SELECT / INSERT / UPDATE のポリシーしか無く、**DELETE のポリシーが
  //      1 つも無い**ので、admin が `DELETE /api/facilities/[id]` を叩いても 0 行になり、
  //      `deleteFacility` がそれを「存在しません」と読んで **404 を返す**（2026-09-08 実測）。
  //      画面に削除ボタンは無いので今のところ誰も踏まないが、後始末には使えない。
  //
  // WHY(結果を見る): 最初はアプリの経路で消して**応答を見ずに捨てていた**ため、
  //      削除が毎回失敗していることに気づかず施設が 5 件残っていた（実測）。
  //      黙って失敗する後始末は、無いのと同じ。消えたことをここで確かめる。
  test.afterEach(async () => {
    const db = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const failures: string[] = []
    while (created.length > 0) {
      const id = created.pop()!
      const { error } = await db.from('facilities').delete().eq('id', id)
      if (error) failures.push(`${id}: ${error.message}`)
      const { data } = await db.from('facilities').select('id').eq('id', id)
      if ((data ?? []).length > 0) failures.push(`${id}: 消したのに残っている`)
    }
    expect(failures, `テストが作った施設を消せなかった:\n${failures.join('\n')}`).toHaveLength(0)
  })

  test('入れた仕切値 × 数量が、そのまま症例発注金額と合計に出る', async ({ page }) => {
    const s = suffix()
    const facilityName = `E2E集計テスト施設-${s}`
    const purchasePrice = 12300
    const quantity = 3

    const facilityId = await createOwnFacility(page.request, facilityName)
    created.push(facilityId)

    // 単価は「その施設のその JAN の仕切値の最小値」（resolve_jan_unit_price）。
    // 施設ごとに付ける値なので、作ったばかりの施設には 1 件だけ入る。
    const priced = await page.request.post('/api/hospital-prices', {
      data: {
        distributorProductId: fixtures!.distributorProductId,
        facilityId,
        purchasePrice,
        deliveryPrice: purchasePrice + 5000,
      },
    })
    expect(priced.status(), `院内価格の登録に失敗: ${await priced.text()}`).toBe(201)

    const order = await page.request.post('/api/case-orders', {
      data: {
        facilityId,
        caseDatetime: new Date().toISOString(),
        procedureName: `E2E集計術式-${s}`,
        patientId: `PT-REPORT-${s}`,
        patientInitials: 'R.P.',
        gender: 'other',
        doctorName: `E2E集計医師-${s}`,
        items: [{ jan: fixtures!.productJan, lot: null, ubd: null, quantity }],
      },
    })
    expect(order.status(), `症例発注の作成に失敗: ${await order.text()}`).toBe(201)

    const today = jstToday()
    await page.goto(`/admin/reports?date_from=${today}&date_to=${today}`)
    await page.waitForLoadState('networkidle')

    const expected = `¥${(purchasePrice * quantity).toLocaleString('ja-JP')}`
    const row = reportRow(page, facilityName)
    await expect(row, '作った施設が集計に出ない').toBeVisible()
    // 症例発注金額と合計の両方に出る（他の種別は発注 0 件なので合計 = 症例分）
    await expect(row.getByText(expected).first(), `${expected} が集計に出ない`).toBeVisible()
    await expect(row).toContainText('-') // 消耗品・短貸は発注 0 件
  })

  // WHY(critical だった指摘そのもの): 「発注はあるが単価データなし」を ¥0 と表示していたのが
  //      過去の欠陥。**発注 0 件（`-`）と金額不明（`-（金額データなし）`）は別物**で、
  //      ¥0 と書いてしまうと「その施設はその期間ただで仕入れた」という誤った読み方になる。
  //      院内価格を付けずに発注すると単価が解決できないので、その状態を実際に作って見る。
  test('院内価格が無い発注は ¥0 ではなく「金額データなし」と出る', async ({ page }) => {
    const s = suffix()
    const facilityName = `E2E金額なし施設-${s}`

    const facilityId = await createOwnFacility(page.request, facilityName)
    created.push(facilityId)

    // 院内価格を**付けない**まま発注する → unit_price は NULL になる
    const order = await page.request.post('/api/case-orders', {
      data: {
        facilityId,
        caseDatetime: new Date().toISOString(),
        procedureName: `E2E金額なし術式-${s}`,
        patientId: `PT-NOAMT-${s}`,
        patientInitials: 'N.A.',
        gender: 'other',
        doctorName: `E2E金額なし医師-${s}`,
        items: [{ jan: fixtures!.productJan, lot: null, ubd: null, quantity: 2 }],
      },
    })
    expect(order.status(), `症例発注の作成に失敗: ${await order.text()}`).toBe(201)

    const today = jstToday()
    await page.goto(`/admin/reports?date_from=${today}&date_to=${today}`)
    await page.waitForLoadState('networkidle')

    const row = reportRow(page, facilityName)
    await expect(row, '作った施設が集計に出ない').toBeVisible()
    await expect(row, '金額不明を ¥0 と表示している').toContainText('金額データなし')
    await expect(row, '金額不明なのに ¥0 と出ている').not.toContainText('¥0')
  })

  // WHY: 期間で切れなければ集計は使えない。1 日単位の境界（JST）で切っていることを、
  //      「今日は出る／昨日までなら出ない」の対で見る。
  test('期間の外に置くと、その発注は集計に入らない', async ({ page }) => {
    const s = suffix()
    const facilityName = `E2E期間テスト施設-${s}`

    const facilityId = await createOwnFacility(page.request, facilityName)
    created.push(facilityId)

    const priced = await page.request.post('/api/hospital-prices', {
      data: {
        distributorProductId: fixtures!.distributorProductId,
        facilityId,
        purchasePrice: 4500,
        deliveryPrice: 9000,
      },
    })
    expect(priced.status()).toBe(201)

    const order = await page.request.post('/api/case-orders', {
      data: {
        facilityId,
        caseDatetime: new Date().toISOString(),
        procedureName: `E2E期間術式-${s}`,
        patientId: `PT-RANGE-${s}`,
        patientInitials: 'R.G.',
        gender: 'other',
        doctorName: `E2E期間医師-${s}`,
        items: [{ jan: fixtures!.productJan, lot: null, ubd: null, quantity: 1 }],
      },
    })
    expect(order.status(), `症例発注の作成に失敗: ${await order.text()}`).toBe(201)

    // 肯定: 今日を含む期間なら金額が出る
    const today = jstToday()
    await page.goto(`/admin/reports?date_from=${today}&date_to=${today}`)
    await page.waitForLoadState('networkidle')
    await expect(reportRow(page, facilityName)).toContainText('¥4,500')

    // 否定: 昨日で切ると、同じ施設の行はあるが金額は入らない（発注 0 件扱い）
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toLocaleDateString('sv-SE', {
      timeZone: 'Asia/Tokyo',
    })
    await page.goto(`/admin/reports?date_from=${yesterday}&date_to=${yesterday}`)
    await page.waitForLoadState('networkidle')
    const row = reportRow(page, facilityName)
    await expect(row, '期間の外なのに集計から施設が消えている').toBeVisible()
    await expect(row, '期間で切っても金額が入っている').not.toContainText('¥4,500')
  })
})
