import { defineConfig } from '@playwright/test'
import { loadEnvConfig } from '@next/env'
import { assertTestSupabaseEnv } from './e2e/env-guard'

// E2Eは本番の .env.local ではなく .env.test のみを読む。
// NODE_ENV=test のとき @next/env は .env.local を読み込まない（Next.js公式仕様）ため、
// 本番Supabaseの接続情報が紛れ込む経路を仕様レベルで断つ。
;(process.env as Record<string, string>).NODE_ENV = 'test'
loadEnvConfig(process.cwd())

// 万一 .env.test やCI secretsに本番URLが設定されていても、webServer起動前に即失敗させる
assertTestSupabaseEnv()

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  retries: process.env.CI ? 1 : 0,
  timeout: 30_000,
  reporter: [['list'], ['./scripts/playwright-loop-observability-reporter.ts']],
  use: {
    baseURL: 'http://localhost:3000',
    storageState: 'e2e/.auth/user.json',
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
    env: {
      // next dev が「非標準NODE_ENV」警告を出さないよう明示的にdevelopmentへ戻す。
      // Supabase接続情報は下で明示指定するため、devサーバー側の .env.local 読み込みでは上書きされない
      NODE_ENV: 'development',
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
      NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
})
