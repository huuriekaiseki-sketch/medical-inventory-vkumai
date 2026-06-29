import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/supabase/require-auth', () => ({ requireAuth: vi.fn().mockResolvedValue({ id: 'u-1', email: 'user@example.com' }) }))
vi.mock('@/lib/categories/repository')

import {
  listCategories,
  createCategory,
  getCategory,
  updateCategory,
  deleteCategory,
} from '@/lib/categories/repository'
import { GET as listGET, POST } from '@/app/api/categories/route'
import {
  GET as detailGET,
  PUT,
  DELETE,
} from '@/app/api/categories/[id]/route'

const mockCategory = {
  id: 'test-id',
  name: 'カテゴリA',
  description: null,
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

describe('GET /api/categories', () => {
  it('カテゴリ一覧を返す', async () => {
    vi.mocked(listCategories).mockResolvedValue([mockCategory])
    const res = await listGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.categories).toHaveLength(1)
    expect(body.categories[0].name).toBe('カテゴリA')
  })
})

describe('POST /api/categories', () => {
  it('正常にカテゴリを作成できる', async () => {
    vi.mocked(createCategory).mockResolvedValue(mockCategory)
    const req = makeRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'カテゴリA', description: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.category.name).toBe('カテゴリA')
  })

  it('name が空なら 400 を返す', async () => {
    const req = makeRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: '', description: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('name がスペースのみなら 400 を返す', async () => {
    const req = makeRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: '   ', description: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
  })

  it('name 重複なら 409 を返す', async () => {
    vi.mocked(createCategory).mockRejectedValue(new Error('カテゴリ名が既に使用されています'))
    const req = makeRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'カテゴリA', description: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
  })

  it('未認証なら POST も 401 を返す', async () => {
    const { requireAuth } = await import('@/lib/supabase/require-auth')
    vi.mocked(requireAuth).mockRejectedValueOnce(new Error('UNAUTHORIZED'))
    const req = makeRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'カテゴリA', description: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(401)
  })
})

describe('GET /api/categories/[id]', () => {
  it('存在するカテゴリを取得できる', async () => {
    vi.mocked(getCategory).mockResolvedValue(mockCategory)
    const req = makeRequest('/api/categories/test-id')
    const res = await detailGET(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.category.id).toBe('test-id')
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(getCategory).mockResolvedValue(null)
    const req = makeRequest('/api/categories/nonexistent')
    const res = await detailGET(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
  })
})

describe('PUT /api/categories/[id]', () => {
  it('正常に更新できる', async () => {
    vi.mocked(updateCategory).mockResolvedValue({ ...mockCategory, name: 'カテゴリB' })
    const req = makeRequest('/api/categories/test-id', {
      method: 'PUT',
      body: JSON.stringify({ name: 'カテゴリB', description: null }),
    })
    const res = await PUT(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.category.name).toBe('カテゴリB')
  })

  it('name が空なら 400', async () => {
    const req = makeRequest('/api/categories/test-id', {
      method: 'PUT',
      body: JSON.stringify({ name: '', description: null }),
    })
    const res = await PUT(req, makeParams('test-id'))
    expect(res.status).toBe(400)
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(updateCategory).mockRejectedValue(new Error('カテゴリID "x" は存在しません'))
    const req = makeRequest('/api/categories/x', {
      method: 'PUT',
      body: JSON.stringify({ name: 'カテゴリX', description: null }),
    })
    const res = await PUT(req, makeParams('x'))
    expect(res.status).toBe(404)
  })

  it('name 重複なら 409', async () => {
    vi.mocked(updateCategory).mockRejectedValue(new Error('カテゴリ名が既に使用されています'))
    const req = makeRequest('/api/categories/test-id', {
      method: 'PUT',
      body: JSON.stringify({ name: 'カテゴリA', description: null }),
    })
    const res = await PUT(req, makeParams('test-id'))
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/categories/[id]', () => {
  it('正常に削除できる', async () => {
    vi.mocked(deleteCategory).mockResolvedValue()
    const req = makeRequest('/api/categories/test-id', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('test-id'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('存在しない ID なら 404', async () => {
    vi.mocked(deleteCategory).mockRejectedValue(new Error('カテゴリID "nonexistent" は存在しません'))
    const req = makeRequest('/api/categories/nonexistent', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
  })

  it('使用中なら 409', async () => {
    vi.mocked(deleteCategory).mockRejectedValue(new Error('使用中のため削除できません'))
    const req = makeRequest('/api/categories/test-id', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('test-id'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('使用中のため削除できません')
  })
})
