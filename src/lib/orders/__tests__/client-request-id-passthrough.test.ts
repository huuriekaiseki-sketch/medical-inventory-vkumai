import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createCaseOrder } from '@/lib/case-orders/repository'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import { createLoanReturn } from '@/lib/loan-returns/repository'

// WHY: 4 つの作成リポジトリが clientRequestId を RPC に渡し、無ければ引数自体を渡さない
//      （RPC の DEFAULT NULL に任せる）ことを固定する（P-053）。
//      「同じ鍵で 2 回呼んでも 1 行」は supabase/__tests__/integration/order-idempotency.integration.test.ts が実 DB で見る。

const KEY = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function makeRpcDb(data: unknown) {
  const rpc = vi.fn().mockResolvedValue({ data, error: null })
  return { db: { rpc } as unknown as SupabaseClient, rpc }
}

const argsOf = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls[0][1] as Record<string, unknown>

describe('createCaseOrder の clientRequestId', () => {
  const base = { caseDatetime: '2026-06-24T10:00:00Z', procedureName: 'TAVI', patientId: 'P001', patientInitials: 'T.S.', gender: 'male' as const, doctorName: '医師', items: [] }
  it('あれば p_client_request_id として渡す', async () => {
    const { db, rpc } = makeRpcDb({ id: 'co-1', items: [] })
    await createCaseOrder(db, 'f-1', { ...base, clientRequestId: KEY })
    expect(argsOf(rpc).p_client_request_id).toBe(KEY)
  })
  it('無ければ引数自体を渡さない', async () => {
    const { db, rpc } = makeRpcDb({ id: 'co-1', items: [] })
    await createCaseOrder(db, 'f-1', base)
    expect('p_client_request_id' in argsOf(rpc)).toBe(false)
  })
})

describe('createLoanOrder の clientRequestId', () => {
  const base = { procedureName: 'PCI', maker: 'メーカー', items: [] }
  it('あれば p_client_request_id として渡す', async () => {
    const { db, rpc } = makeRpcDb({ id: 'lo-1', items: [] })
    await createLoanOrder(db, 'f-1', { ...base, clientRequestId: KEY })
    expect(argsOf(rpc).p_client_request_id).toBe(KEY)
  })
  it('無ければ引数自体を渡さない', async () => {
    const { db, rpc } = makeRpcDb({ id: 'lo-1', items: [] })
    await createLoanOrder(db, 'f-1', base)
    expect('p_client_request_id' in argsOf(rpc)).toBe(false)
  })
})

describe('createConsumableOrder の clientRequestId', () => {
  const base = { items: [{ consumableId: 'c-1', quantity: 1 }] }
  it('あれば p_client_request_id として渡す', async () => {
    const { db, rpc } = makeRpcDb({ id: 'cs-1', items: [] })
    await createConsumableOrder(db, 'f-1', { ...base, clientRequestId: KEY })
    expect(argsOf(rpc).p_client_request_id).toBe(KEY)
  })
  it('無ければ引数自体を渡さない', async () => {
    const { db, rpc } = makeRpcDb({ id: 'cs-1', items: [] })
    await createConsumableOrder(db, 'f-1', base)
    expect('p_client_request_id' in argsOf(rpc)).toBe(false)
  })
})

describe('createLoanReturn の clientRequestId（p_header の中で渡す）', () => {
  const base = { returnDatetime: '2026-06-24T15:00:00Z', items: [] }
  it('あれば p_header.client_request_id として渡す', async () => {
    const { db, rpc } = makeRpcDb({ id: 'lr-1', items: [] })
    await createLoanReturn(db, 'f-1', { ...base, clientRequestId: KEY })
    expect((argsOf(rpc).p_header as Record<string, unknown>).client_request_id).toBe(KEY)
  })
  it('無ければ p_header に鍵を入れない', async () => {
    const { db, rpc } = makeRpcDb({ id: 'lr-1', items: [] })
    await createLoanReturn(db, 'f-1', base)
    expect('client_request_id' in (argsOf(rpc).p_header as Record<string, unknown>)).toBe(false)
  })
})
