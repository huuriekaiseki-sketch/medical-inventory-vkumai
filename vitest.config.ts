import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // integration.test.ts は vitest.integration.config.ts（実DB接続用の別設定）でのみ実行する。
    // 除外しないと npm test（jsdom環境・DB非接続前提）が本物のSupabase接続を試みて壊れる。
    exclude: [
      '**/e2e/**',
      '**/node_modules/**',
      '**/.claude/worktrees/**',
      '**/*.integration.test.ts',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
