import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { mapDistributorProduct } from '../repository'

describe('mapDistributorProduct 型ガード/NaNガード', () => {
  it('正常な行を変換する', () => {
    expect(
      mapDistributorProduct({
        id: '1', product_id: 'p', maker: 'm', supplier: 's', name: 'n',
        reimbursement_price: 100, quantity: 5, category_id: 'c',
        created_at: 'cr', updated_at: 'up',
      })
    ).toEqual({
      id: '1', productId: 'p', maker: 'm', supplier: 's', name: 'n',
      reimbursementPrice: 100, quantity: 5, categoryId: 'c',
      createdAt: 'cr', updatedAt: 'up',
    })
  })
  it('quantity が不正値なら 0、reimbursement_price が null なら null', () => {
    const r = mapDistributorProduct({
      id: '1', product_id: 'p', maker: 'm', supplier: 's', name: 'n',
      reimbursement_price: null, quantity: 'abc', category_id: 'c',
      created_at: 'cr', updated_at: 'up',
    })
    expect(r.quantity).toBe(0)
    expect(r.reimbursementPrice).toBeNull()
  })
})
