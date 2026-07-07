import { createClient } from '@supabase/supabase-js'
import { chromium } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import * as fs from 'fs'
import * as path from 'path'
import { assertTestSupabaseEnv } from './env-guard'

// E2Eは本番の .env.local ではなく .env.test のみを読む。
// NODE_ENV=test のとき @next/env は .env.local を読み込まない（Next.js公式仕様）ため、
// 本番Supabaseの接続情報が紛れ込む経路を仕様レベルで断つ。
;(process.env as Record<string, string>).NODE_ENV = 'test'
loadEnvConfig(process.cwd())

// 万一 .env.test やCI secretsに本番URLが設定されていても、ここで即失敗させる
assertTestSupabaseEnv()

export async function generateAuthState() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const testEmail = process.env.E2E_TEST_EMAIL

  const authFilePath = path.join(process.cwd(), 'e2e', '.auth', 'user.json')
  fs.mkdirSync(path.dirname(authFilePath), { recursive: true })

  if (!supabaseUrl || !serviceRoleKey || !testEmail) {
    console.warn('[E2E auth] E2E_TEST_EMAIL / SUPABASE_SERVICE_ROLE_KEY が未設定。認証なしで実行します。')
    // 空のstorageStateを書く（Playwrightがファイル不在でクラッシュするのを防ぐ）
    fs.writeFileSync(authFilePath, JSON.stringify({ cookies: [], origins: [] }))
    return
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // テストユーザーが未登録でもgenerateLinkが失敗しないよう、先に明示的に作成しておく。
  // 既に存在する場合はエラーになるが、その場合は「既存ユーザーを使う」で問題ないため無視する。
  const { error: createUserError } = await supabase.auth.admin.createUser({
    email: testEmail,
    email_confirm: true,
  })
  if (createUserError && createUserError.code !== 'email_exists') {
    throw new Error(`テストユーザー作成失敗: ${createUserError.message}`)
  }

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  const siteOrigin = new URL(siteUrl).origin

  // Admin API でマジックリンクを直接生成（メール送信不要）。
  // redirectToを明示しないとSupabase側のsite_url設定に依存し、127.0.0.1へ飛んで
  // Cookieドメインがずれる事故が起きるため、必ずテストのbaseURLと同じオリジンを指定する
  const { data, error } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: testEmail,
    options: { redirectTo: `${siteUrl}/` },
  })

  if (error || !data.properties?.action_link) {
    throw new Error(`テストセッション生成失敗: ${error?.message}`)
  }

  // ブラウザでリンクを開いてセッションCookieを取得。
  // 環境変数が揃っているのに認証に失敗した場合は空のstorageStateで誤魔化さず即失敗させる
  // （空stateだと後続テストが未認証のまま走り、原因が分かりにくいリダイレクト失敗として現れるため）
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(data.properties.action_link)

    // マジックリンク検証後は /#access_token=... や /login#access_token=... など
    // hash付きURLに着地するため、完全一致ではなくオリジン到達で判定する
    await page.waitForURL((url) => url.origin === siteOrigin, { timeout: 30_000 })

    // 認証完了はURLではなくSupabaseのauth Cookie（sb-*-auth-token）の出現で判定する
    // （login/page.tsx のuseEffectがhashからsetSessionし終わるまで非同期のため）
    const deadline = Date.now() + 30_000
    let authenticated = false
    while (Date.now() < deadline) {
      const cookies = await page.context().cookies()
      if (cookies.some((c) => /^sb-.+-auth-token/.test(c.name))) {
        authenticated = true
        break
      }
      await page.waitForTimeout(500)
    }
    if (!authenticated) {
      throw new Error(
        '[E2E auth] 認証Cookie（sb-*-auth-token）が30秒以内に設定されませんでした。' +
          'マジックリンクのリダイレクト先とログインフロー（/login のhash処理）を確認してください。'
      )
    }

    await page.context().storageState({ path: authFilePath })
    console.log(`[E2E auth] 認証済みstorageStateを書き出しました: ${authFilePath}`)
  } finally {
    await browser.close()
  }
}

// CLIから直接実行された場合（npm run e2e:auth 等）にも動くようにする。
// import.meta.url ではなく argv で判定し、tsx実行時のCJS/ESMどちらでも同じ挙動にする。
const isMainModule = process.argv[1]?.endsWith('generate-auth-state.ts')
if (isMainModule) {
  generateAuthState().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
