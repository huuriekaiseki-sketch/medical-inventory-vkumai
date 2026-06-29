import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/supabase/require-auth', () => ({ requireAuth: vi.fn().mockResolvedValue({ id: 'u-1', email: 'user@example.com' }) }))
vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: vi.fn().mockImplementation(async (_db: unknown, _user: unknown, fid: string | null) => {
    if (!fid) throw new Error('FACILITY_ID_REQUIRED')
    return { facilityId: fid }
  }),
}))
vi.mock('@/lib/case-orders/repository')
vi.mock('@/lib/consumable-orders/repository')
vi.mock('@/lib/loan-orders/repository')
vi.mock('@/lib/loan-returns/repository')

import { listCaseOrders } from '@/lib/case-orders/repository'
import { listConsumableOrders } from '@/lib/consumable-orders/repository'
import { listLoanOrders } from '@/lib/loan-orders/repository'
import { listLoanReturns } from '@/lib/loan-returns/repository'
import { requireFacilityAccess } from '@/lib/supabase/require-facility-access'

import { GET as caseOrdersGET } from '@/app/api/case-orders/route'
import { GET as consumableOrdersGET } from '@/app/api/consumable-orders/route'
import { GET as loanOrdersGET } from '@/app/api/loan-orders/route'
import { GET as loanReturnsGET } from '@/app/api/loan-returns/route'

function makeGET(url: string) {
  return new NextRequest(`http://localhost${url}`)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(requireFacilityAccess).mockImplementation(async (_db, _user, fid) => {
    if (!fid) throw new Error('FACILITY_ID_REQUIRED')
    return { facilityId: fid }
  })
})

describe('GET /api/case-orders', () => {
  it('facility_id がないと 400', async () => {
    const res = await caseOrdersGET(makeGET('/api/case-orders'))
    expect(res.status).toBe(400)
  })

  it('facility_id 指定で一覧を返す', async () => {
    vi.mocked(listCaseOrders).mockResolvedValue([])
    const res = await caseOrdersGET(makeGET('/api/case-orders?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.orders)).toBe(true)
  })

  it('リポジトリエラーを 500 で返す', async () => {
    vi.mocked(listCaseOrders).mockRejectedValue(new Error('DB エラー'))
    const res = await caseOrdersGET(makeGET('/api/case-orders?facility_id=f1'))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/consumable-orders', () => {
  it('facility_id がないと 400', async () => {
    const res = await consumableOrdersGET(makeGET('/api/consumable-orders'))
    expect(res.status).toBe(400)
  })

  it('facility_id 指定で一覧を返す', async () => {
    vi.mocked(listConsumableOrders).mockResolvedValue([])
    const res = await consumableOrdersGET(makeGET('/api/consumable-orders?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.orders)).toBe(true)
  })
})

describe('GET /api/loan-orders', () => {
  it('facility_id がないと 400', async () => {
    const res = await loanOrdersGET(makeGET('/api/loan-orders'))
    expect(res.status).toBe(400)
  })

  it('facility_id 指定で一覧を返す', async () => {
    vi.mocked(listLoanOrders).mockResolvedValue([])
    const res = await loanOrdersGET(makeGET('/api/loan-orders?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.orders)).toBe(true)
  })
})

describe('GET /api/loan-returns', () => {
  it('facility_id がないと 400', async () => {
    const res = await loanReturnsGET(makeGET('/api/loan-returns'))
    expect(res.status).toBe(400)
  })

  it('facility_id 指定で一覧を返す', async () => {
    vi.mocked(listLoanReturns).mockResolvedValue([])
    const res = await loanReturnsGET(makeGET('/api/loan-returns?facility_id=f1'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.returns)).toBe(true)
  })
})
