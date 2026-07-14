import { defineConfig } from 'vitest/config'
import path from 'path'

// WHY: 既存 vitest.config.ts は jsdom 環境・DB非接続前提（モックテスト用）。
//      本物のローカルSupabaseに接続するRLS/IDOR統合テスト(issue #165)を混在させると、
//      誤って本物のDBに繋ぐテストがモック漏れで壊れるリスクがあるため設定を分離する。
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['supabase/__tests__/integration/**/*.integration.test.ts'],
    globalSetup: ['./supabase/__tests__/integration/helpers/global-setup.ts'],
    // 統合テストは実DBへのユーザー作成・サインインを伴うため、単体テストより長めに取る
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
