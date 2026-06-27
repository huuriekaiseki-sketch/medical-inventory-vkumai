import { createClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

async function globalSetup() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const testEmail = process.env.E2E_TEST_EMAIL

  const authFilePath = path.join(process.cwd(), 'e2e', '.auth', 'user.json')
  fs.mkdirSync(path.dirname(authFilePath), { recursive: true })

  if (!supabaseUrl || !serviceRoleKey || !testEmail) {
    console.warn('[E2E global-setup] E2E_TEST_EMAIL / SUPABASE_SERVICE_ROLE_KEY が未設定。認証なしで実行します。')
    // 空のstorageStateを書く（Playwrightがファイル不在でクラッシュするのを防ぐ）
    fs.writeFileSync(authFilePath, JSON.stringify({ cookies: [], origins: [] }))
    return
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // Admin API でマジックリンクを直接生成（メール送信不要）
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: testEmail,
  })

  if (error || !data.properties?.action_link) {
    throw new Error(`テストセッション生成失敗: ${error?.message}`)
  }

  // ブラウザでリンクを開いてセッションCookieを取得
  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(data.properties.action_link)
  await page.waitForURL('/')
  await page.context().storageState({ path: authFilePath })
  await browser.close()
}

export default globalSetup
