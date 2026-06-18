import { describe, it, expect, beforeEach } from 'vitest'
import {
  listProducts,
  getProduct,
  createProduct,
  updateProduct,
  deleteProduct,
  resetProducts,
} from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

const sampleInput: ProductInput = {
  name: 'テスト製品A',
  code: 'PRD-001',
  category: '消耗品',
  unit: '個',
  unitPrice: 1000,
}

const sampleInput2: ProductInput = {
  name: 'テスト製品B',
  code: 'PRD-002',
  category: '機器',
  unit: '台',
  unitPrice: 50000,
}

describe('製品マスタ リポジトリ（インメモリ）', () => {
  beforeEach(() => {
    resetProducts()
  })

  // --- CRUD 正常系 ---

  it('createProduct: 製品を作成し、id・createdAt・updatedAtが付与される', async () => {
    const product = await createProduct(sampleInput)

    expect(product.id).toBeDefined()
    expect(product.name).toBe(sampleInput.name)
    expect(product.code).toBe(sampleInput.code)
    expect(product.category).toBe(sampleInput.category)
    expect(product.unit).toBe(sampleInput.unit)
    expect(product.unitPrice).toBe(sampleInput.unitPrice)
    expect(product.createdAt).toBeDefined()
    expect(product.updatedAt).toBeDefined()
  })

  it('getProduct: 作成した製品をIDで取得できる', async () => {
    const created = await createProduct(sampleInput)
    const found = await getProduct(created.id)

    expect(found).not.toBeNull()
    expect(found!.id).toBe(created.id)
    expect(found!.name).toBe(sampleInput.name)
  })

  it('getProduct: 存在しないIDではnullを返す', async () => {
    const found = await getProduct('non-existent-id')
    expect(found).toBeNull()
  })

  it('listProducts: 全製品を一覧取得できる', async () => {
    await createProduct(sampleInput)
    await createProduct(sampleInput2)

    const list = await listProducts()
    expect(list).toHaveLength(2)
  })

  it('listProducts: 空の場合は空配列を返す', async () => {
    const list = await listProducts()
    expect(list).toHaveLength(0)
  })

  it('updateProduct: 製品情報を更新できる', async () => {
    const created = await createProduct(sampleInput)
    const updatedInput: ProductInput = {
      ...sampleInput,
      name: '更新済み製品',
      unitPrice: 2000,
    }

    const updated = await updateProduct(created.id, updatedInput)

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe('更新済み製品')
    expect(updated.unitPrice).toBe(2000)
    expect(updated.createdAt).toBe(created.createdAt)
    // updatedAtは更新されているはず（createdAtと同じか後）
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(created.createdAt).getTime()
    )
  })

  it('deleteProduct: 製品を削除できる', async () => {
    const created = await createProduct(sampleInput)
    await deleteProduct(created.id)

    const found = await getProduct(created.id)
    expect(found).toBeNull()

    const list = await listProducts()
    expect(list).toHaveLength(0)
  })

  // --- エラー系 ---

  it('createProduct: 製品コード重複時にエラーを投げる', async () => {
    await createProduct(sampleInput)

    await expect(createProduct(sampleInput)).rejects.toThrow()
  })

  it('updateProduct: 存在しないIDで更新するとエラーを投げる', async () => {
    await expect(updateProduct('non-existent-id', sampleInput)).rejects.toThrow()
  })

  it('updateProduct: 他の製品と製品コードが重複する場合エラーを投げる', async () => {
    const product1 = await createProduct(sampleInput)
    await createProduct(sampleInput2)

    // product1のコードをproduct2のコードに変更しようとする
    const duplicateInput: ProductInput = {
      ...sampleInput,
      code: sampleInput2.code,
    }

    await expect(updateProduct(product1.id, duplicateInput)).rejects.toThrow()
  })

  it('updateProduct: 自分自身と同じコードなら更新可能', async () => {
    const created = await createProduct(sampleInput)
    const updatedInput: ProductInput = {
      ...sampleInput,
      name: '名前だけ変更',
    }

    // 同じコードのまま他フィールドを更新 → エラーにならない
    const updated = await updateProduct(created.id, updatedInput)
    expect(updated.name).toBe('名前だけ変更')
    expect(updated.code).toBe(sampleInput.code)
  })

  it('deleteProduct: 存在しないIDで削除するとエラーを投げる', async () => {
    await expect(deleteProduct('non-existent-id')).rejects.toThrow()
  })

  // --- resetProducts ---

  it('resetProducts: 全データがクリアされる', async () => {
    await createProduct(sampleInput)
    await createProduct(sampleInput2)

    resetProducts()

    const list = await listProducts()
    expect(list).toHaveLength(0)
  })
})
