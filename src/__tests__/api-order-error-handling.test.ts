import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/case-orders/repository')
vi.mock('@/lib/consumable-orders/repository')
vi.mock('@/lib/loan-orders/repository')
vi.mock('@/lib/loan-returns/repository')

import { createCaseOrder } from '@/lib/case-orders/repository'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import { createLoanReturn } from '@/lib/loan-returns/repository'

import { POST as caseOrderPOST } from '@/app/api/case-orders/route'
import { POST as consumableOrderPOST } from '@/app/api/consumable-orders/route'
import { POST as loanOrderPOST } from '@/app/api/loan-orders/route'
import { POST as loanReturnPOST } from '@/app/api/loan-returns/route'

function makeRequest(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => vi.resetAllMocks())

describe('consumable-orders エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createConsumableOrder).mockRejectedValue(new Error('DB エラー'))
    const res = await consumableOrderPOST(
      makeRequest('/api/consumable-orders', {
        facilityId: 'f1',
        items: [{ name: 'A', quantity: 1 }],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
    expect(body.error).toBe('DB エラー')
  })
})

describe('loan-orders エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createLoanOrder).mockRejectedValue(new Error('DB エラー'))
    const res = await loanOrderPOST(
      makeRequest('/api/loan-orders', {
        facilityId: 'f1',
        procedureName: 'PCI',
        maker: 'M',
        items: [],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

describe('loan-returns エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createLoanReturn).mockRejectedValue(new Error('DB エラー'))
    const res = await loanReturnPOST(
      makeRequest('/api/loan-returns', {
        facilityId: 'f1',
        returnDatetime: '2026-06-25T00:00:00Z',
        items: [],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

describe('quantity: 0 は有効データとして処理される', () => {
  it('case-orders: quantity 0 のアイテムでも 400 にならない', async () => {
    vi.mocked(createCaseOrder).mockResolvedValue({
      id: 'o1',
      facilityId: 'f1',
      caseDatetime: '2026-06-25T00:00:00Z',
      procedureName: 'PCI',
      patientId: 'p1',
      patientInitials: 'AB',
      gender: 'male',
      doctorName: 'Dr',
      status: 'draft',
      items: [],
      createdAt: '',
      updatedAt: '',
    })
    const res = await caseOrderPOST(
      makeRequest('/api/case-orders', {
        facilityId: 'f1',
        caseDatetime: '2026-06-25T00:00:00Z',
        procedureName: 'PCI',
        patientId: 'p1',
        patientInitials: 'AB',
        gender: 'male',
        doctorName: 'Dr',
        items: [{ jan: '4901234567890', quantity: 0 }],
      })
    )
    expect(res.status).toBe(201)
  })
})
