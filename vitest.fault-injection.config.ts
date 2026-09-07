import { defineConfig } from 'vitest/config'
import path from 'path'

// WHY: issue #757 の 31（fail-open）。棚卸し（docs/agents/fail-open-inventory.md）の 19 行のうち
//      **実際に依存を止めて測ったのは 1 行だけ**で、残りはコードを読んだ判断だった。
//      「error を受け取っているか」は静的検査で見られるが、**そもそも error として返ってくるのか、
//      それとも throw されるのか**は、本物を止めてみないと分からない。
//
//      この設定は `bash scripts/measure-fail-open.sh` からだけ使う。
//      **ローカルのコンテナを止めるので CI では回さない**（統合テストとも設定を分ける。
//      同じ include に置くと、依存を止めるテストが毎 PR で走ってしまう）。
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['supabase/__tests__/fault-injection/**/*.faultinjection.test.ts'],
    globalSetup: ['./supabase/__tests__/integration/helpers/global-setup.ts'],
    // 依存を止めた状態の待ちは長い（PostgREST の接続タイムアウト等）
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // 依存を止める順序が混ざらないよう 1 ファイルずつ直列に走らせる
    fileParallelism: false,
    // WHY: このスイートは**出力そのものが成果物**（棚卸しに書き写す測定値）。
    //      既定では成功したテストの console.log が捨てられ、緑になった瞬間に数字が消える
    disableConsoleIntercept: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
