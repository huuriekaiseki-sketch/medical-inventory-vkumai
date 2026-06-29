import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import { requireAuth } from '@/lib/supabase/require-auth'

function makeDb(user: User | null, error: Error | null = null): SupabaseClient {
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user }, error }),
    },
  } as unknown as SupabaseClient
}

describe('requireAuth', () => {
  it('認証済みユーザーを返す', async () => {
    const user = { id: 'u-1', email: 'test@example.com' } as User
    const result = await requireAuth(makeDb(user))
    expect(result).toBe(user)
  })

  it('user が null の場合 UNAUTHORIZED をスロー', async () => {
    await expect(requireAuth(makeDb(null))).rejects.toThrow('UNAUTHORIZED')
  })

  it('error がある場合 UNAUTHORIZED をスロー', async () => {
    const user = { id: 'u-1', email: 'test@example.com' } as User
    await expect(requireAuth(makeDb(user, new Error('session error')))).rejects.toThrow('UNAUTHORIZED')
  })
})
