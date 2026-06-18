import { describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { resetProducts, createProduct } from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

// Route handlers
import { GET as listGET, POST } from '@/app/api/products/route'
import {
  GET as detailGET,
  PUT,
  DELETE,
} from '@/app/api/products/[id]/route'

const validInput: ProductInput = {
  name: 'テスト製品',
  code: 'TEST-001',
  category: '医薬品',
  unit: '箱',
  unitPrice: 1000,
}

function makeRequest(url: string, init?: RequestInit) {
  return new NextRequest(`http://localhost${url}`, init)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

describe('GET /api/products', () => {
  beforeEach(() => resetProducts())

  it('空の場合は空配列を返す', async () => {
    const res = await listGET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ products: [] })
  })

  it('データがある場合は製品一覧を返す', async () => {
    await createProduct(validInput)
    const res = await listGET()
    const body = await res.json()
    expect(body.products).toHaveLength(1)
    expect(body.products[0].code).toBe('TEST-001')
  })
})

describe('POST /api/products', () => {
  beforeEach(() => resetProducts())

  it('正常に製品を作成できる', async () => {
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify(validInput),
    })
    const res = await POST(req)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.product.name).toBe('テスト製品')
    expect(body.product.code).toBe('TEST-001')
    expect(body.product.id).toBeDefined()
  })

  it('必須項目が未入力なら400を返す', async () => {
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify({ name: '', code: '', category: '', unit: '', unitPrice: null }),
    })
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('必須項目が未入力です')
  })

  it('製品コードが重複していたら409を返す', async () => {
    await createProduct(validInput)
    const req = makeRequest('/api/products', {
      method: 'POST',
      body: JSON.stringify(validInput),
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('製品コードが重複しています')
  })
})

describe('GET /api/products/[id]', () => {
  beforeEach(() => resetProducts())

  it('存在する製品を取得できる', async () => {
    const product = await createProduct(validInput)
    const req = makeRequest(`/api/products/${product.id}`)
    const res = await detailGET(req, makeParams(product.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.product.id).toBe(product.id)
  })

  it('存在しないIDなら404を返す', async () => {
    const req = makeRequest('/api/products/nonexistent')
    const res = await detailGET(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('製品が見つかりません')
  })
})

describe('PUT /api/products/[id]', () => {
  beforeEach(() => resetProducts())

  it('正常に製品を更新できる', async () => {
    const product = await createProduct(validInput)
    const updateInput: ProductInput = {
      ...validInput,
      name: '更新製品',
    }
    const req = makeRequest(`/api/products/${product.id}`, {
      method: 'PUT',
      body: JSON.stringify(updateInput),
    })
    const res = await PUT(req, makeParams(product.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.product.name).toBe('更新製品')
  })

  it('存在しないIDなら404を返す', async () => {
    const req = makeRequest('/api/products/nonexistent', {
      method: 'PUT',
      body: JSON.stringify(validInput),
    })
    const res = await PUT(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('製品が見つかりません')
  })

  it('製品コードが重複していたら409を返す', async () => {
    const p1 = await createProduct(validInput)
    await createProduct({ ...validInput, code: 'TEST-002', name: '別製品' })
    const req = makeRequest(`/api/products/${p1.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...validInput, code: 'TEST-002' }),
    })
    const res = await PUT(req, makeParams(p1.id))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toBe('製品コードが重複しています')
  })
})

describe('DELETE /api/products/[id]', () => {
  beforeEach(() => resetProducts())

  it('正常に製品を削除できる', async () => {
    const product = await createProduct(validInput)
    const req = makeRequest(`/api/products/${product.id}`, { method: 'DELETE' })
    const res = await DELETE(req, makeParams(product.id))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
  })

  it('存在しないIDなら404を返す', async () => {
    const req = makeRequest('/api/products/nonexistent', { method: 'DELETE' })
    const res = await DELETE(req, makeParams('nonexistent'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('製品が見つかりません')
  })
})
