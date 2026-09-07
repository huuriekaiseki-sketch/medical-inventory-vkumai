import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // WHY: issue #757 の 15。Vercel は UTC で動く。開発機（JST）でしか通らない日付整形を
    //      CI と手元の両方で同じ条件（UTC）で走らせて見つける。JST に依存する整形は
    //      src/lib/format-date.ts が Asia/Tokyo を明示する
    env: { TZ: 'UTC' },
    // integration.test.ts は vitest.integration.config.ts（実DB接続用の別設定）でのみ実行する。
    // 除外しないと npm test（jsdom環境・DB非接続前提）が本物のSupabase接続を試みて壊れる。
    exclude: [
      '**/e2e/**',
      '**/node_modules/**',
      '**/.claude/worktrees/**',
      '**/*.integration.test.ts',
      // WHY(2026-09-08): 障害注入の測定は **docker のコンテナを止める**。既定の include は
      //      `*.test.ts` に当たるので、除外しないと `npm test` が依存を止めにいく。
      //      起動は bash scripts/measure-fail-open.sh（vitest.fault-injection.config.ts）だけ
      '**/*.faultinjection.test.ts',
      // フレーキー検知（scripts/check-flaky-tests.test.sh）の RED 方向 fixture。意図的に落ちるテストなので
      // 通常の npm test では回さない（scripts/eval-fixtures/flaky/vitest.config.mjs だけが拾う）
      '**/scripts/eval-fixtures/**',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
