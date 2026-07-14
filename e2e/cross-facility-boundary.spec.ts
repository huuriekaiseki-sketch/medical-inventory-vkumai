// e2e/cross-facility-boundary.spec.ts
// WHY: issue #321（issue #315の後半として切り出し）。RLS/IDOR統合テスト（supabase/__tests__/integration/）
//      はAPI/RPCレベルでのクロス施設境界を検証済みだが、UIレベル（実際のページ描画）での
//      境界検証が存在しなかった。施設Bのユーザーが施設Aのloan-orders一覧を開いても、
//      シードされた発注が見えないこと（アクセス権限エラーになること）をブラウザ越しに確認する。

import { test, expect } from '@playwright/test'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

const fixtures = readCrossFacilityFixtures()

test.describe('施設間クロスアクセス境界（issue #321）', () => {
  test.skip(!fixtures, 'cross-facilityフィクスチャが生成されていない（SUPABASE_SERVICE_ROLE_KEY等が未設定）')

  test('ユーザーAは自分の施設Aのloan-orders一覧で、シードした発注を閲覧できる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-orders`)
    await page.waitForLoadState('networkidle')

    await expect(page.getByText(fixtures!.loanOrderProcedureName)).toBeVisible()

    await context.close()
  })

  test('ユーザーBが施設Aのloan-orders一覧を開くと、アクセス権限エラーになりシード済み発注は見えない', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()
    await page.goto(`/facilities/${fixtures!.facilityAId}/loan-orders`)
    await page.waitForLoadState('networkidle')

    // src/app/api/loan-orders/route.ts の requireFacilityAccess が403を返し、
    // src/app/facilities/[id]/loan-orders/page.tsx が「一覧の取得に失敗しました」を表示する
    // （空の一覧として素通りするのではなく、明示的なエラーとして現れる）
    await expect(page.getByText('一覧の取得に失敗しました')).toBeVisible()
    await expect(page.getByText(fixtures!.loanOrderProcedureName)).not.toBeVisible()

    await context.close()
  })
})
