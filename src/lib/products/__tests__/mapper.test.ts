import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { mapProduct } from '../repository'

describe('mapProduct 型ガード', () => {
  it('正常な行を変換する', () => {
    expect(
      mapProduct({ id: '1', jan: 'J', ref: 'R', created_at: 'c', updated_at: 'u' })
    ).toEqual({ id: '1', jan: 'J', ref: 'R', createdAt: 'c', updatedAt: 'u' })
  })
  it('null/型不一致でも空文字でフォールバックする', () => {
    expect(
      mapProduct({ id: null, jan: 123, ref: undefined, created_at: {}, updated_at: 'u' })
    ).toEqual({ id: '', jan: '', ref: '', createdAt: '', updatedAt: 'u' })
  })
})
