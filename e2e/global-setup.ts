import { createClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

async function globalSetup() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const testEmail = process.env.E2E_TEST_EMAIL

  if (!supabaseUrl || !serviceRoleKey || !testEmail) {
    throw new Error('E2E: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / E2E_TEST_EMAIL が未設定')
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
  const authDir = path.join(process.cwd(), 'e2e', '.auth')
  fs.mkdirSync(authDir, { recursive: true })

  const browser = await chromium.launch()
  const page = await browser.newPage()
  await page.goto(data.properties.action_link)
  await page.waitForURL('/')
  await page.context().storageState({ path: path.join(authDir, 'user.json') })
  await browser.close()
}

export default globalSetup
