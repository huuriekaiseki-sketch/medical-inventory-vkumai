import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/supabase/require-auth', () => ({ requireAuth: vi.fn().mockResolvedValue({ id: 'u-1', email: 'user@example.com' }) }))
vi.mock('@/lib/products/repository')

import {
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
} from '@/lib/products/repository'
import { GET as listGET, POST } from '@/app/api/products/route'
import {
  GET as detailGET,
  PUT,
  DELETE,
} from '@/app/api/products/[id]/route'

const mockProduct = {
  id: 'test-id',
  jan: '4901234567890',
  ref: 'REF-001',
  name: '製品A',
  maker: null,
  createdAt: '2026-06-18T00:00:00Z',
  updatedAt: '2026-06-18T00:00:00Z',
}

function makeRequest(url: string, init?: Omit<RequestInit, 'signal'> & { signal?: AbortSignal }) {
  return new NextRequest(`http://localhost${url}`, init)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.resetAllMocks())

describe('GET /api/products', () => {
  it('製品一覧を返す', async () => {
    vi.mocked(listProducts).mockResolvedValue([mockProduct])
    const res = await listGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.products).toHaveLength(1)
    expect(body.products[0].jan).toBe('4901234567890')
  })
})

describe('POST /api/products', () => {
  it('正常に製品を作成できる', async () => {
    vi.mocked(createProduct).mockResolvedValue(mockProduct)
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001', name: '製品A' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.product.jan).toBe('4901234567890')
  })

  it('jan が空なら 400 を返す', async () => {
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ jan: '', ref: 'REF-001' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('JAN 重複なら 409 を返す', async () => {
    vi.mocked(createProduct).mockRejectedValue(new Error('JAN または REF が既に使用されています'))
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001', name: '製品A' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
  })

  it('name が空なら 400 を返す', async () => {
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001', name: '' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('未認証なら POST も 401 を返す', async () => {
    const { requireAuth } = await import('@/lib/supabase/require-auth')
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error('UNAUTHORIZED'))
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001', name: '製品A' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/products/[id]', () => {
  it('存在する製品を取得できる', async () => {
    vi.mocked(getProduct).mockResolvedValue(mockProduct)
    const req = makeRequest('/api/products/test-id')
    const res = await detailGET(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.product.id).toBe('test-id')
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(getProduct).mockResolvedValue(null)
    const req = makeRequest('/api/products/nonexistent')
    const res = await detailGET(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/products/[id]', () => {
  it('正常に更新できる', async () => {
    vi.mocked(updateProduct).mockResolvedValue({ ...mockProduct, ref: 'REF-002' })
    const req = makeRequest('/api/products/test-id', {
      method: 'PUT',
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-002', name: '製品A' }),
    })
    const res = await PUT(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.product.ref).toBe('REF-002')
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(updateProduct).mockRejectedValue(new Error('製品ID "x" は存在しません'))
    const req = makeRequest('/api/products/x', {
      method: 'PUT',
      body: JSON.stringify({ jan: '1234567890123', ref: 'REF-X', name: '製品X' }),
    })
    const res = await PUT(req, makeParams('x'))
    expect(res.status).toBe(404)
  })
})

describe('DELETE /api/products/[id]', () => {
  it('正常に削除できる', async () => {
    vi.mocked(deleteProduct).mockResolvedValue()
    const req = makeRequest('/api/products/test-id', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(deleteProduct).mockRejectedValue(new Error('製品ID "nonexistent" は存在しません'))
    const req = makeRequest('/api/products/nonexistent', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('製品が見つかりません')
  })
})
