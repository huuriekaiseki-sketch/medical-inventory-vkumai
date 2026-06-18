import type { Product, ProductInput } from '@/types/product'

const store = new Map<string, Product>()

export async function listProducts(): Promise<Product[]> {
  return Array.from(store.values())
}

export async function getProduct(id: string): Promise<Product | null> {
  return store.get(id) ?? null
}

export async function createProduct(input: ProductInput): Promise<Product> {
  // 製品コード重複チェック
  for (const existing of store.values()) {
    if (existing.code === input.code) {
      throw new Error(`製品コード "${input.code}" は既に使用されています`)
    }
  }

  const now = new Date().toISOString()
  const product: Product = {
    id: crypto.randomUUID(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  store.set(product.id, product)
  return product
}

export async function updateProduct(id: string, input: ProductInput): Promise<Product> {
  const existing = store.get(id)
  if (!existing) {
    throw new Error(`製品ID "${id}" は存在しません`)
  }

  // 自分以外に同じ製品コードが存在するかチェック
  for (const other of store.values()) {
    if (other.id !== id && other.code === input.code) {
      throw new Error(`製品コード "${input.code}" は既に使用されています`)
    }
  }

  const updated: Product = {
    ...existing,
    ...input,
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  }
  store.set(id, updated)
  return updated
}

export async function deleteProduct(id: string): Promise<void> {
  if (!store.has(id)) {
    throw new Error(`製品ID "${id}" は存在しません`)
  }
  store.delete(id)
}

export function resetProducts(): void {
  store.clear()
}
