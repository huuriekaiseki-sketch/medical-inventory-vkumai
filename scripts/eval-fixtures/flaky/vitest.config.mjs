// scripts/check-flaky-tests.test.sh の RED 方向 fixture 専用の vitest 設定。
// 通常の npm test（vitest.config.ts）はこのディレクトリを除外している。
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['scripts/eval-fixtures/flaky/**/*.test.mjs'],
  },
})
