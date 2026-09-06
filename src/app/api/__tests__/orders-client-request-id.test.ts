import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { POST as postCaseOrder } from '../case-orders/route'
import { POST as postLoanOrder } from '../loan-orders/route'
import { POST as postConsumableOrder } from '../consumable-orders/route'
import { POST as postLoanReturn } from '../loan-returns/route'
import { CLIENT_REQUEST_ID_INVALID_MESSAGE } from '@/lib/client-request-id'

// WHY: 4 つの作成 route が body.clientRequestId を「UUID なら通す・UUID でなければ 400・無ければ従来どおり」
//      で扱い、リポジトリの input に載せることを固定する（P-053）。DB の挙動は統合テストが見る。

const mockGetUser = vi.fn()
const mockRequireFacilityAccess = vi.fn()
const mockCreateCaseOrder = vi.fn()
const mockCreateLoanOrder = vi.fn()
const mockCreateConsumableOrder = vi.fn()
const mockCreateLoanReturn = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerSupabase: async () => ({ auth: { getUser: mockGetUser } }),
}))
vi.mock('@/lib/supabase/require-facility-access', () => ({
  requireFacilityAccess: (...args: unknown[]) => mockRequireFacilityAccess(...args),
}))
vi.mock('@/lib/case-orders/repository', () => ({
  listCaseOrders: vi.fn(),
  createCaseOrder: (...args: unknown[]) => mockCreateCaseOrder(...args),
}))
vi.mock('@/lib/loan-orders/repository', () => ({
  listLoanOrders: vi.fn(),
  createLoanOrder: (...args: unknown[]) => mockCreateLoanOrder(...args),
}))
vi.mock('@/lib/consumable-orders/repository', () => ({
  listConsumableOrders: vi.fn(),
  createConsumableOrder: (...args: unknown[]) => mockCreateConsumableOrder(...args),
}))
vi.mock('@/lib/loan-returns/repository', () => ({
  listLoanReturns: vi.fn(),
  createLoanReturn: (...args: unknown[]) => mockCreateLoanReturn(...args),
}))

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function req(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'u1@test.com' } }, error: null })
  mockRequireFacilityAccess.mockResolvedValue({ facilityId: 'f1' })
  mockCreateCaseOrder.mockResolvedValue({ id: 'co1' })
  mockCreateLoanOrder.mockResolvedValue({ id: 'lo1' })
  mockCreateConsumableOrder.mockResolvedValue({ id: 'cs1' })
  mockCreateLoanReturn.mockResolvedValue({ id: 'lr1' })
})

const caseBody = { facilityId: 'f1', caseDatetime: '2026-06-24T10:00', procedureName: 'TAVI', patientId: 'P1', patientInitials: 'T.S.', gender: 'male', doctorName: '医師', items: [] }
const loanBody = { facilityId: 'f1', procedureName: 'PCI', maker: 'メーカー', items: [] }
const consumableBody = { facilityId: 'f1', items: [{ consumableId: 'c1', quantity: 1 }] }
const returnBody = { facilityId: 'f1', returnDatetime: '2026-06-24T15:00:00Z', items: [] }

const cases = [
  ['POST /api/case-orders', '/api/case-orders', postCaseOrder, caseBody, mockCreateCaseOrder, 2],
  ['POST /api/loan-orders', '/api/loan-orders', postLoanOrder, loanBody, mockCreateLoanOrder, 2],
  ['POST /api/consumable-orders', '/api/consumable-orders', postConsumableOrder, consumableBody, mockCreateConsumableOrder, 2],
  ['POST /api/loan-returns', '/api/loan-returns', postLoanReturn, returnBody, mockCreateLoanReturn, 2],
] as const

describe.each(cases)('%s の clientRequestId', (_name, path, post, body, mockCreate, inputIndex) => {
  it('UUID の clientRequestId はリポジトリの input に載る', async () => {
    const res = await post(req(path, { ...body, clientRequestId: KEY }))
    expect(res.status).toBe(201)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    const input = mockCreate.mock.calls[0][inputIndex] as { clientRequestId?: string }
    expect(input.clientRequestId).toBe(KEY)
  })

  it('clientRequestId が無ければ undefined のまま通る（従来の呼び出し）', async () => {
    const res = await post(req(path, body))
    expect(res.status).toBe(201)
    const input = mockCreate.mock.calls[0][inputIndex] as { clientRequestId?: string }
    expect(input.clientRequestId).toBeUndefined()
  })

  it('UUID でない clientRequestId は 400 で、リポジトリは呼ばれない', async () => {
    const res = await post(req(path, { ...body, clientRequestId: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(CLIENT_REQUEST_ID_INVALID_MESSAGE)
    expect(mockCreate).not.toHaveBeenCalled()
  })
})
