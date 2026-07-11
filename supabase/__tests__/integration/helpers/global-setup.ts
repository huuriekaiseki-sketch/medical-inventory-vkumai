// supabase/__tests__/integration/helpers/global-setup.ts
// WHY: 統合テストは本物のSupabaseに接続する初めてのVitestスイートのため、
//      個々のテストファイル・シードヘルパーに到達する前にVitestのglobalSetupで
//      本番接続防止ガードを掛ける。セット1（シードヘルパー内のガード呼び出し）との
//      二重防御であり、片方の呼び出し漏れがあっても本番接続をブロックできるようにする。

import { loadEnvConfig } from '@next/env'
import { assertTestSupabaseEnv } from '../../../../e2e/env-guard'

export default function globalSetup() {
  // E2Eと同じく .env.test のみを読む（.env.local を読まないよう NODE_ENV=test を強制する）
  ;(process.env as Record<string, string>).NODE_ENV = 'test'
  loadEnvConfig(process.cwd())

  assertTestSupabaseEnv()
}
