// supabase/__tests__/integration/helpers/global-setup.ts
// WHY: 統合テストは本物のSupabaseに接続する初めてのVitestスイートのため、
//      個々のテストファイル・シードヘルパーに到達する前にVitestのglobalSetupで
//      本番接続防止ガードを掛ける。セット1（シードヘルパー内のガード呼び出し）との
//      二重防御であり、片方の呼び出し漏れがあっても本番接続をブロックできるようにする。

import { loadEnvConfig } from '@next/env'
import { assertTestSupabaseEnv } from '../../../../e2e/env-guard'
import {
  snapshotIntegrationRows,
  verifyIntegrationRows,
  countKeys,
} from './fixture-guard'

export default async function globalSetup() {
  // E2Eと同じく .env.test のみを読む（.env.local を読まないよう NODE_ENV=test を強制する）
  ;(process.env as Record<string, string>).NODE_ENV = 'test'
  loadEnvConfig(process.cwd())

  assertTestSupabaseEnv()

  // WHY(C-030、2026-09-09): **どのファイルも走り出す前**の姿を控える。
  //      ここより後に作られた行は控えに入らないので、各ファイルは自分が作ったものを自由に消せる。
  //      消えて困るのは E2E のフィクスチャ・別ファイルの行・前回までの実行が残した行。
  const snapshot = await snapshotIntegrationRows()
  console.log(
    `[fixture-guard/integration] 走行前の ${countKeys(snapshot)} 行を控えました` +
      '（後片付けがこれを消したら teardown で落ちます）'
  )

  // WHY(teardown を返す): vitest の globalSetup は**返した関数**を全ファイルの後に呼ぶ。
  //      ここで throw すると実行そのものが失敗する（前提は
  //      `scripts/check-fixture-guard.test.sh` の scenario 8 が実測している）。
  //      個々のファイルに足さないのは、**どのファイルが犯人でも同じ 1 か所で捕まえたい**から。
  return async () => {
    await verifyIntegrationRows(snapshot)
  }
}
