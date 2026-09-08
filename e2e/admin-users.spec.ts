import { test, expect, type Page } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

// WHY: 管理画面（/admin 配下 4 枚）は E2E に一度も出てこなかった。API への総当たり攻撃
//      （P-017）は route を機械列挙して叩いているが、**画面から操作されたことは一度も無い**。
//      ここは「誰がどの施設で何をできるか」を書き換える唯一の画面で、
//      その値をすべての RLS ポリシー（is_facility_writer / is_admin）が読む。
//
//      層ごとの検査は揃っている（UserTable の単体・route の単体・
//      permission-change-authz の実 DB 統合）。**揃っていないのは層と層の間**で、
//      今日見つけた実害 3 件（E-050 / E-051 / E-052）はすべてそこにあった。
//
//      **ここで測らないこと**:
//      - 権限を変えた相手が実際に書けなくなること → `rbac-viewer-role.integration.test.ts` と
//        `permission-change-authz.integration.test.ts` が実 DB で測る（画面からは 1 ブラウザで
//        別人のセッションを作れない）
//      - 招待メールが実際に届くこと → 送信は GoTrue の中で起き、画面からは観測できない
//      - 招待・削除が privileged_operations に残ること（P-066）→ 読む画面が無いので統合テスト側

const fixtures = readCrossFacilityFixtures()
const ADMIN_EMAIL = process.env.E2E_TEST_EMAIL

/** テストが作る利用者の目印。後始末はこの接頭辞で拾う */
const PREFIX = 'e2e-admin-users-'

function uniqueEmail() {
  return `${PREFIX}${Date.now()}-${Math.floor(Math.random() * 10000)}@example.test`
}

async function openUsers(page: Page) {
  await page.goto('/admin/users')
  await page.waitForLoadState('networkidle')
}

/** メールで行を引く。展開行は別の <tr> なので、操作の起点にだけ使う */
function rowOf(page: Page, email: string) {
  return page.getByRole('row', { name: new RegExp(email) })
}

test.describe('利用者と権限の管理（画面から） [P-035]', () => {
  test.skip(!fixtures?.facilityAName, 'cross-facility フィクスチャが生成されていない')

  // WHY(必ず消す): 招待は**本物の auth 利用者**を作る。失敗して残ると手元の DB にたまり続け、
  //      E-062（利用者が 52 人になって globalSetup ごと落ちた）と同じ形になる。
  //      product の削除経路（DELETE /api/admin/users）をそのまま使う。
  test.afterEach(async ({ page }) => {
    const res = await page.request.get('/api/admin/users')
    if (!res.ok()) return
    const { users } = await res.json()
    for (const u of users ?? []) {
      if (typeof u.email === 'string' && u.email.startsWith(PREFIX)) {
        await page.request.delete('/api/admin/users', { data: { userId: u.id } })
      }
    }
  })

  test('招待した利用者が一覧に出て、施設と権限を付けられ、削除で消える', async ({ page }) => {
    const email = uniqueEmail()
    const facilityName = fixtures!.facilityAName!
    await openUsers(page)

    // 1. 招待する
    await page.getByRole('button', { name: '+ 招待' }).click()
    await page.getByPlaceholder('メールアドレス').fill(email)
    const [inviteRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/admin/users') && res.request().method() === 'POST'
      ),
      page.getByRole('button', { name: '招待する' }).click(),
    ])
    expect(
      inviteRes.status(),
      `POST /api/admin/users failed (${inviteRes.status()}): ${await inviteRes.text()}`
    ).toBe(200)

    // 2. 一覧に出る（招待の直後に一覧を取り直している）
    await expect(rowOf(page, email)).toBeVisible()

    // 3. 展開して施設を付ける
    await rowOf(page, email).getByRole('button', { name: '展開して設定' }).click()
    const checkbox = page.getByRole('checkbox', { name: facilityName })
    await expect(checkbox).not.toBeChecked()
    // WHY(check() ではなく click()): このチェックボックスは制御された入力で、
    //      `checked` は**サーバーが 200 を返して state が更新されるまで変わらない**。
    //      `check()` は押した直後に状態が変わることを要求するので必ず落ちる。
    //      押す → 応答を待つ → 印が付いたことを見る、の順で測る。
    const [addRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/admin/user-facilities') && res.request().method() === 'POST'
      ),
      checkbox.click(),
    ])
    expect(addRes.status(), `所属の追加に失敗: ${await addRes.text()}`).toBe(200)
    await expect(checkbox, '所属を付けたのに印が付かない').toBeChecked()

    // 既定は staff（画面が送っている値。ここが変わると既定の権限が変わる）
    const roleSelect = page.getByLabel(`${facilityName}のrole`)
    await expect(roleSelect).toHaveValue('staff')

    // 4. 権限を viewer に落とす
    const [roleRes] = await Promise.all([
      page.waitForResponse(
        (res) =>
          res.url().includes('/api/admin/user-facilities') && res.request().method() === 'POST'
      ),
      roleSelect.selectOption('viewer'),
    ])
    expect(roleRes.status(), `権限の変更に失敗: ${await roleRes.text()}`).toBe(200)

    // 5. 画面を作り直しても viewer のまま（＝画面の表示ではなく DB が変わっている）
    await openUsers(page)
    await rowOf(page, email).getByRole('button', { name: '展開して設定' }).click()
    await expect(
      page.getByLabel(`${facilityName}のrole`),
      '再読み込みすると権限が戻る（画面だけ変えて保存できていない）'
    ).toHaveValue('viewer')

    // 6. 削除すると一覧から消える
    page.once('dialog', (d) => d.accept())
    const [deleteRes] = await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes('/api/admin/users') && res.request().method() === 'DELETE'
      ),
      rowOf(page, email).getByRole('button', { name: '削除' }).click(),
    ])
    expect(deleteRes.status(), `削除に失敗: ${await deleteRes.text()}`).toBe(200)
    await expect(page.getByText('ユーザーを削除しました')).toBeVisible()

    await openUsers(page)
    await expect(rowOf(page, email), '削除したのに一覧に残っている').toHaveCount(0)
  })

  // WHY: 自分を消せてしまうと、その施設の admin が 0 人になって誰も権限を戻せなくなる
  //      （復旧には service_role キーが要る）。route は 400 で止めるので、
  //      **画面から押しても止まること**と、止まったことが利用者に伝わることを見る。
  test('自分自身は削除できない。押しても止まり、理由が画面に出る', async ({ page }) => {
    test.skip(!ADMIN_EMAIL, 'E2E_TEST_EMAIL が未設定')
    await openUsers(page)

    const me = rowOf(page, ADMIN_EMAIL!)
    await expect(me).toBeVisible()

    page.once('dialog', (d) => d.accept())
    const [res] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes('/api/admin/users') && r.request().method() === 'DELETE'
      ),
      me.getByRole('button', { name: '削除' }).click(),
    ])
    expect(res.status()).toBe(400)
    await expect(page.getByText('自分自身は削除できません')).toBeVisible()

    // 消えていない（画面の楽観更新が先に行を消していないこと）
    await expect(rowOf(page, ADMIN_EMAIL!)).toBeVisible()
    await openUsers(page)
    await expect(rowOf(page, ADMIN_EMAIL!)).toBeVisible()
  })
})

test.describe('管理画面の境界（画面から） [P-017]', () => {
  test.skip(!fixtures?.facilityAName, 'cross-facility フィクスチャが生成されていない')

  // WHY: P-017 の攻撃表は API を叩いて「admin 系は proxy が /login へリダイレクト」と
  //      書いているが、**画面を開いたときにどうなるか**は測っていなかった。
  //      施設スタッフが URL を直打ちする経路をそのまま見る。
  test('施設スタッフが /admin/users を直接開くと /login に飛ばされ、利用者の一覧は 1 行も見えない', async ({
    browser,
  }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()

    await page.goto('/admin/users')
    await page.waitForLoadState('networkidle')

    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole('heading', { name: 'ユーザー管理' })).toHaveCount(0)
    // 管理者のメールアドレスが 1 文字も出ていない（一覧が裏で描画されていない）
    if (ADMIN_EMAIL) {
      await expect(page.getByText(ADMIN_EMAIL, { exact: false })).toHaveCount(0)
    }

    await context.close()
  })
})
