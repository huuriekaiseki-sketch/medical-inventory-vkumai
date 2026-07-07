import { generateAuthState } from './generate-auth-state'

async function globalSetup() {
  await generateAuthState()
}

export default globalSetup
