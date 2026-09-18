import { generateAuthState } from './generate-auth-state'
import { generateCrossFacilityAuthState } from './generate-cross-facility-auth-state'
import { snapshotProtectedRows } from './fixture-guard'

async function globalSetup() {
  await generateAuthState()
  // issue #321: cross-facility-boundary.spec.ts用の2ユーザー×2施設フィクスチャ
  await generateCrossFacilityAuthState()

  // WHY(C-030、2026-09-09): **フィクスチャの用意が終わった直後**に控える。
  //      ここより後に作られた行は控えに入らないので、spec は自分が作ったものを自由に消せる。
  //      控えるのはフィクスチャの行と、前回までの実行が残した行。
  const n = await snapshotProtectedRows()
  console.log(`[fixture-guard] 走行前の ${n} 行を控えました（後片付けがこれを消したら teardown で落ちます）`)
}

export default globalSetup
