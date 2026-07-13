import { generateAuthState } from './generate-auth-state'
import { generateCrossFacilityAuthState } from './generate-cross-facility-auth-state'

async function globalSetup() {
  await generateAuthState()
  // issue #321: cross-facility-boundary.spec.ts用の2ユーザー×2施設フィクスチャ
  await generateCrossFacilityAuthState()
}

export default globalSetup
