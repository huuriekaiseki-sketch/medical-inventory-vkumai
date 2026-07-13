import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { mapProduct } from '../repository'

describe('mapProduct 型ガード', () => {
  it('正常な行を変換する', () => {
    expect(
      mapProduct({
        id: '1',
        jan: 'J',
        ref: 'R',
        name: 'カテーテルAB型',
        maker: 'テルモ',
        created_at: 'c',
        updated_at: 'u',
      })
    ).toEqual({
      id: '1',
      jan: 'J',
      ref: 'R',
      name: 'カテーテルAB型',
      maker: 'テルモ',
      createdAt: 'c',
      updatedAt: 'u',
    })
  })
  it('null/型不一致でも空文字でフォールバックする', () => {
    expect(
      mapProduct({
        id: null,
        jan: 123,
        ref: undefined,
        name: undefined,
        maker: undefined,
        created_at: {},
        updated_at: 'u',
      })
    ).toEqual({
      id: '',
      jan: '',
      ref: '',
      name: '',
      maker: null,
      createdAt: '',
      updatedAt: 'u',
    })
  })
  it('maker が null の場合は null を保持する（空文字に丸めない）', () => {
    expect(
      mapProduct({
        id: '1',
        jan: 'J',
        ref: 'R',
        name: 'N',
        maker: null,
        created_at: 'c',
        updated_at: 'u',
      })
    ).toEqual({
      id: '1',
      jan: 'J',
      ref: 'R',
      name: 'N',
      maker: null,
      createdAt: 'c',
      updatedAt: 'u',
    })
  })
})
