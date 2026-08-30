// supabase/__tests__/integration/helpers/mfa-totp.ts
// WHY: issue #684。require-aal2-in-facility-writer-rls.integration.test.ts と
//      require-aal2-for-order-rpcs.integration.test.ts に同一のTOTP生成・enroll・
//      aal2昇格ロジックが重複していた。今後AAL2テストを増やすたびに複製されるのを防ぐため
//      共通ヘルパーとして抽出する。TOTPコードはRFC 6238に基づきNode組み込みcryptoのみで
//      生成し、新規npm依存(otpauth等)を追加しない方針を踏襲する。

import { createHmac } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/=+$/, '')
  let bits = ''
  for (const char of clean) {
    const val = alphabet.indexOf(char)
    if (val === -1) throw new Error(`invalid base32 character: ${char}`)
    bits += val.toString(2).padStart(5, '0')
  }
  const bytes: number[] = []
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(parseInt(bits.slice(i, i + 8), 2))
  }
  return Buffer.from(bytes)
}

// RFC 6238 (TOTP) / RFC 4226 (HOTP) 準拠。30秒ステップ・6桁・SHA1。
export function generateTotp(secretBase32: string): string {
  const key = base32Decode(secretBase32)
  const counter = Math.floor(Date.now() / 1000 / 30)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))
  const hmac = createHmac('sha1', key).update(counterBuffer).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return (binCode % 1_000_000).toString().padStart(6, '0')
}

// TOTP factorをenroll・challenge・verifyし、以降のstepUpToAal2で使うfactorId/secretを返す。
// 呼び出し時点のclientはaal1でサインイン済みであること。
export async function enrollAndVerifyTotp(
  client: SupabaseClient
): Promise<{ factorId: string; secret: string }> {
  const { data: enrollData, error: enrollError } = await client.auth.mfa.enroll({ factorType: 'totp' })
  if (enrollError || !enrollData) throw new Error(`MFA enroll失敗: ${enrollError?.message}`)
  const factorId = enrollData.id
  const secret = enrollData.totp.secret

  const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
  if (challengeError || !challengeData) throw new Error(`MFA challenge失敗: ${challengeError?.message}`)

  const { error: verifyError } = await client.auth.mfa.verify({
    factorId,
    challengeId: challengeData.id,
    code: generateTotp(secret),
  })
  if (verifyError) throw new Error(`MFA verify失敗: ${verifyError.message}`)

  return { factorId, secret }
}

// パスワードのみの再サインインは、factorが検証済みでも新規セッションはaal1から始まる
// (src/middleware.tsのnextLevel判定と同じ挙動)。
export async function signInAtAal1(client: SupabaseClient, email: string, password: string): Promise<void> {
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`サインイン失敗: ${error.message}`)
}

// 既にaal1でサインイン済みのclientに対し、challenge+verifyを実行してaal2まで昇格させる。
export async function stepUpToAal2(client: SupabaseClient, factorId: string, secret: string): Promise<void> {
  const { data: challengeData, error: challengeError } = await client.auth.mfa.challenge({ factorId })
  if (challengeError || !challengeData) throw new Error(`MFA challenge失敗: ${challengeError?.message}`)
  const { error: verifyError } = await client.auth.mfa.verify({
    factorId,
    challengeId: challengeData.id,
    code: generateTotp(secret),
  })
  if (verifyError) throw new Error(`MFA verify失敗: ${verifyError.message}`)
}
