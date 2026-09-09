// e2e/price-history.spec.ts
// WHY: 価格変更履歴の画面（`/distributor-products/[id]/price-history`）は、
//      **一度も E2E で開かれていなかった**（2026-09-09 時点）。
//      この画面が出すのは施設ごとの仕切値とその改定履歴、そして施設名で、
//      脅威モデルの資産 A-02（施設ごとの価格＝商談条件）そのものにあたる。
//
//      同時に、この spec は攻撃スイープ（api-cross-facility-attack.spec.ts, P-017）の
//      **対の検査**でもある。攻撃側は「施設 B の利用者に施設 A の仕切値が出ないこと」を
//      目印の不在で判定するので、**その目印がそもそも出うるもの**であることを
//      どこかで示さないと、履歴が空のままでも通ってしまう（空振り）。
//      ここで「施設 A の利用者には確かに出る」を測ることで、攻撃側の不在判定に意味を与える。
//
// WHY(自前の代理店商品を作る、2026-09-09): 最初はグローバルのフィクスチャが作る
//      「施設 A × フィクスチャの代理店商品」の履歴を見ていたが、**全体実行でだけ落ちた**。
//      院内価格を消すと価格履歴も一緒に消える（20260906000007）ため、
//      並列で走る hospital-prices.spec.ts の後片付けが履歴ごと巻き添えにしていた。
//      施設 A の院内価格は複数の spec が同時に触る共有物なので、ここでは
//      **この spec しか触らない代理店商品**を作り、その上に履歴を作る。

import { test, expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import {
  readCrossFacilityFixtures,
  CROSS_FACILITY_USER_A_AUTH_PATH,
  CROSS_FACILITY_USER_B_AUTH_PATH,
} from './generate-cross-facility-auth-state'

const fixtures = readCrossFacilityFixtures()

/** 改定後の仕切値。他の spec が作る値（100000〜999999）と桁ごと外して衝突を避ける */
const REVISED_PURCHASE_PRICE = 7654321
const ORIGINAL_PURCHASE_PRICE = 1234567

/** 画面は ¥7,654,321 の形（3 桁区切り）で出す。生値から画面上の表記を作る */
function formatPrice(value: number): string {
  return `¥${value.toLocaleString('ja-JP')}`
}

function serviceRoleClient(): SupabaseClient {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface OwnFixture {
  categoryId: string
  productId: string
  distributorProductId: string
  hospitalPriceId: string
}

let own: OwnFixture | null = null

async function openPriceHistory(page: Page, distributorProductId: string): Promise<void> {
  await page.goto(`/distributor-products/${distributorProductId}/price-history`)
  await expect(page.getByRole('heading', { name: '価格変更履歴' })).toBeVisible()
  // 一覧は fetch 後に描画される。読み込み中の表示が消えるまで待つ
  await expect(page.getByText('読み込み中...')).toHaveCount(0)
}

// 約束カタログ（docs/agents/promise-catalog.md）: P-016 画面経由でも施設境界
test.describe('価格変更履歴の画面と施設境界 [P-016]', () => {
  test.skip(!fixtures?.facilityAId, 'cross-facility フィクスチャが無い')
  test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY が未設定（シードに必要）')

  test.beforeAll(async () => {
    const db = serviceRoleClient()
    const runId = randomUUID()

    const insert = async (table: string, row: Record<string, unknown>) => {
      const { data, error } = await db.from(table).insert(row).select('id').single()
      if (error || !data) throw new Error(`[price-history] ${table} のシード失敗: ${error?.message}`)
      return data.id as string
    }

    const categoryId = await insert('categories', { name: `E2E価格履歴カテゴリ-${runId}` })
    const productId = await insert('products', { jan: `e2e-ph-jan-${runId}`, ref: `e2e-ph-ref-${runId}` })
    const distributorProductId = await insert('distributor_products', {
      product_id: productId,
      category_id: categoryId,
      maker: `E2E価格履歴メーカー-${runId}`,
      supplier: `E2E価格履歴卸-${runId}`,
      name: `E2E価格履歴商品-${runId}`,
      quantity: 1,
    })
    const hospitalPriceId = await insert('hospital_prices', {
      distributor_product_id: distributorProductId,
      facility_id: fixtures!.facilityAId,
      purchase_price: ORIGINAL_PURCHASE_PRICE,
      delivery_price: 2222222,
    })

    // WHY(作るだけでなく変える): 価格履歴は**値が変わったときだけ** 1 行残る（I-041）。
    //      INSERT しただけでは履歴が生まれないので、ここで 1 回だけ改定する。
    const { error } = await db
      .from('hospital_prices')
      .update({ purchase_price: REVISED_PURCHASE_PRICE })
      .eq('id', hospitalPriceId)
    if (error) throw new Error(`[price-history] 価格改定のシード失敗: ${error.message}`)

    own = { categoryId, productId, distributorProductId, hospitalPriceId }
  })

  test.afterAll(async () => {
    if (!own) return
    const db = serviceRoleClient()
    // 院内価格 → 代理店商品 → 製品 / カテゴリの順（外部キーの向き）。
    // 院内価格を消すと価格履歴も一緒に消える（20260906000007）
    await db.from('hospital_prices').delete().eq('id', own.hospitalPriceId)
    await db.from('distributor_products').delete().eq('id', own.distributorProductId)
    await db.from('products').delete().eq('id', own.productId)
    await db.from('categories').delete().eq('id', own.categoryId)
    own = null
  })

  test('施設 A の利用者は、自施設の仕切値の改定と施設名を見られる', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_A_AUTH_PATH })
    const page = await context.newPage()
    await openPriceHistory(page, own!.distributorProductId)

    // 取得に失敗したときも「変更履歴はありません」と似た空表示になるため、エラーの不在を先に見る
    await expect(page.getByText('履歴の取得に失敗しました')).toHaveCount(0)

    // 改定後の仕切値（= 攻撃 spec が「漏れていないこと」の目印に使うのと同じ種類の値）
    await expect(page.getByText(formatPrice(REVISED_PURCHASE_PRICE))).toBeVisible()
    // 変更前の値も履歴として残る
    await expect(page.getByText(formatPrice(ORIGINAL_PURCHASE_PRICE))).toBeVisible()
    // 種別の欄に施設名が出る（PriceHistoryRow の entityLabel）
    await expect(page.getByText(`施設価格（${fixtures!.facilityAName}）`)).toBeVisible()

    await context.close()
  })

  test('施設 B の利用者が同じ画面を開いても、施設 A の仕切値も施設名も出ない', async ({ browser }) => {
    const context = await browser.newContext({ storageState: CROSS_FACILITY_USER_B_AUTH_PATH })
    const page = await context.newPage()
    await openPriceHistory(page, own!.distributorProductId)

    // 取得そのものは成功していること（エラー画面なら「何も出ない」のは当たり前で、境界を測れていない）
    await expect(page.getByText('履歴の取得に失敗しました')).toHaveCount(0)

    // WHY(漏洩の判定を先に置く): 空表示の確認を先に書くと、境界が壊れたときの失敗メッセージが
    //      「空表示が無い」になり、**何が漏れたか**が出ない。実際 2026-09-09 の RED 確認で
    //      そうなったので、漏れてはいけないものの不在を先に判定する。
    //      3 桁区切りの有無にかかわらず落とすため、生値と表示形の両方を見る
    await expect(page.getByText(String(REVISED_PURCHASE_PRICE))).toHaveCount(0)
    await expect(page.getByText(formatPrice(REVISED_PURCHASE_PRICE))).toHaveCount(0)
    await expect(page.getByText(formatPrice(ORIGINAL_PURCHASE_PRICE))).toHaveCount(0)
    await expect(page.getByText(fixtures!.facilityAName!)).toHaveCount(0)

    // 施設スコープの行は RPC 内の手書き WHERE（is_facility_member OR is_admin）で落ちる。
    // 施設に属さない商品マスタ側の改定はこの商品には無いので、一覧は空になる
    await expect(page.getByText('変更履歴はありません')).toBeVisible()

    await context.close()
  })
})
