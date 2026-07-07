import { describe, it, expect } from 'vitest'
import { assertTestSupabaseEnv } from '../../e2e/env-guard'

// vitest.config.ts が e2e/** をテスト対象から除外しているため、
// ガード本体は e2e/ に置きつつテストは src/lib/ 側からimportして検証する

describe('assertTestSupabaseEnv', () => {
  it('URL未設定なら何もしない（認証なしフォールバックに委ねる）', () => {
    expect(() => assertTestSupabaseEnv({})).not.toThrow()
  })

  it('localhost / 127.0.0.1 はデフォルトで許可される', () => {
    expect(() =>
      assertTestSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54321' })
    ).not.toThrow()
    expect(() =>
      assertTestSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'http://localhost:54321' })
    ).not.toThrow()
  })

  it('許可リスト外のホスト（本番Supabase想定）は即失敗する', () => {
    expect(() =>
      assertTestSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
      })
    ).toThrow(/テスト許可ホストではありません/)
  })

  it('E2E_ALLOWED_SUPABASE_HOSTS で明示したホストは許可される', () => {
    expect(() =>
      assertTestSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
        E2E_ALLOWED_SUPABASE_HOSTS: 'test-project.supabase.co',
      })
    ).not.toThrow()
  })

  it('許可リストに別ホストを入れても、対象外の本番ホストはブロックされる', () => {
    expect(() =>
      assertTestSupabaseEnv({
        NEXT_PUBLIC_SUPABASE_URL: 'https://prod-project.supabase.co',
        E2E_ALLOWED_SUPABASE_HOSTS: 'test-project.supabase.co',
      })
    ).toThrow(/テスト許可ホストではありません/)
  })

  it('URLとして不正な値はエラーになる', () => {
    expect(() =>
      assertTestSupabaseEnv({ NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })
    ).toThrow(/URLとして不正/)
  })
})
