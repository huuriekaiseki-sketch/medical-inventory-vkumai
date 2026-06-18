# Supabase スキーマ再設計 + データ層移行 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** インメモリ単一テーブルを廃止し、Supabase 上の4テーブル構成（products / distributor_products / facilities / hospital_prices）に移行してCRUD APIを実装する

**Architecture:** Supabase service role クライアントをサーバーサイド限定で使用。Repository 層で snake_case ↔ camelCase 変換を吸収し、API routes の呼び出しインターフェースは維持する。API テストはリポジトリをモックして Supabase 呼び出しを隔離する。

**Tech Stack:** Next.js 15 (App Router), @supabase/supabase-js ^2, TypeScript, Vitest

## Global Constraints

- `SUPABASE_SERVICE_ROLE_KEY` は `NEXT_PUBLIC_` プレフィックスなし（ブラウザに露出させない）
- snake_case (DB) ↔ camelCase (TypeScript) の変換は各 repository の `map*` 関数で行う
- Supabase error code `PGRST116` = 行なし（404相当）、`23505` = 一意制約違反（409相当）、`23503` = 外部キー違反（404相当）
- `npm test` 全通過・`npm run lint` 通過が各タスクの完了条件
- 既存コンポーネントテスト（ProductForm, ProductList, DeleteConfirmDialog）は Task 9 で削除する（旧スキーマ依存）

---

### Task 1: DBマイグレーション（旧テーブル廃止 + 4テーブル新設）

**Files:**
- Delete: `supabase/migrations/20260618055941_create_products_table.sql`
- Create: `supabase/migrations/<timestamp>_recreate_schema.sql`（`supabase migration new` で生成）

**Interfaces:**
- Produces: DB上に `products`, `facilities`, `distributor_products`, `hospital_prices` テーブル

- [ ] **Step 1: 既存マイグレーションを削除**

```bash
rm supabase/migrations/20260618055941_create_products_table.sql
```

- [ ] **Step 2: 新マイグレーションファイルを生成**

```bash
supabase migration new recreate_schema
```

生成されたファイルパス（例: `supabase/migrations/20260618070000_recreate_schema.sql`）を控えておく。

- [ ] **Step 3: マイグレーション SQL を記述**

生成されたファイルに以下を記述（ファイルは空なので全文貼り付け）:

```sql
-- 旧テーブル廃止
drop table if exists products cascade;

-- updated_at 自動更新関数
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- 製品マスタ
create table products (
  id uuid primary key default gen_random_uuid(),
  jan text not null unique,
  ref text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger products_updated_at
  before update on products
  for each row execute procedure update_updated_at();

-- 施設マスタ
create table facilities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger facilities_updated_at
  before update on facilities
  for each row execute procedure update_updated_at();

-- 代理店テーブル
create table distributor_products (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id) on delete cascade,
  maker text not null,
  supplier text not null,
  name text not null,
  reimbursement_price numeric,
  quantity integer not null default 1,
  category text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger distributor_products_updated_at
  before update on distributor_products
  for each row execute procedure update_updated_at();

-- 病院別価格
create table hospital_prices (
  id uuid primary key default gen_random_uuid(),
  distributor_product_id uuid not null references distributor_products(id) on delete cascade,
  facility_id uuid not null references facilities(id) on delete cascade,
  purchase_price numeric not null,
  delivery_price numeric not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(distributor_product_id, facility_id)
);
create trigger hospital_prices_updated_at
  before update on hospital_prices
  for each row execute procedure update_updated_at();
```

- [ ] **Step 4: マイグレーションを適用**

```bash
supabase db push
```

Expected: `Finished supabase db push.`

- [ ] **Step 5: コミット**

```bash
git add supabase/migrations/
git commit -m "feat: recreate DB schema with 4-table structure"
```

---

### Task 2: Supabase サーバークライアント + 環境変数

**Files:**
- Create: `src/lib/supabase/server.ts`
- Modify: `.env.local`

**Interfaces:**
- Produces: `supabase` (named export) — 各 repository が `import { supabase } from '@/lib/supabase/server'` で使う

- [ ] **Step 1: SUPABASE_SERVICE_ROLE_KEY を .env.local に追記**

`.env.local` の末尾に追記（値は Supabase ダッシュボードの Settings → API → `service_role` キー）:

```
SUPABASE_SERVICE_ROLE_KEY=<ダッシュボードの service_role key>
```

- [ ] **Step 2: Supabase クライアントを作成**

`src/lib/supabase/server.ts` を新規作成:

```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)
```

- [ ] **Step 3: ビルド確認**

```bash
npm run build 2>&1 | tail -5
```

Expected: `Route (app)` テーブルが表示されエラーなし

- [ ] **Step 4: コミット**

```bash
git add src/lib/supabase/server.ts
git commit -m "feat: add Supabase server-side client"
```

---

### Task 3: TypeScript 型定義（新スキーマ）

**Files:**
- Modify: `src/types/product.ts`（新スキーマで上書き）
- Create: `src/types/distributorProduct.ts`
- Create: `src/types/facility.ts`
- Create: `src/types/hospitalPrice.ts`

**Interfaces:**
- Produces: `Product`, `ProductInput`, `DistributorProduct`, `DistributorProductInput`, `Facility`, `FacilityInput`, `HospitalPrice`, `HospitalPriceInput`

- [ ] **Step 1: src/types/product.ts を新スキーマで上書き**

```typescript
export type Product = {
  id: string
  jan: string
  ref: string
  createdAt: string
  updatedAt: string
}

export type ProductInput = {
  jan: string
  ref: string
}
```

- [ ] **Step 2: src/types/distributorProduct.ts を新規作成**

```typescript
export type DistributorProduct = {
  id: string
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  category: string
  createdAt: string
  updatedAt: string
}

export type DistributorProductInput = {
  productId: string
  maker: string
  supplier: string
  name: string
  reimbursementPrice: number | null
  quantity: number
  category: string
}
```

- [ ] **Step 3: src/types/facility.ts を新規作成**

```typescript
export type Facility = {
  id: string
  name: string
  createdAt: string
  updatedAt: string
}

export type FacilityInput = {
  name: string
}
```

- [ ] **Step 4: src/types/hospitalPrice.ts を新規作成**

```typescript
export type HospitalPrice = {
  id: string
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
  createdAt: string
  updatedAt: string
}

export type HospitalPriceInput = {
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
}
```

- [ ] **Step 5: lint 確認**

```bash
npm run lint
```

- [ ] **Step 6: コミット**

```bash
git add src/types/
git commit -m "feat: update TypeScript types for 4-table schema"
```

---

### Task 4: Products リポジトリ（Supabase 版）

**Files:**
- Modify: `src/lib/products/repository.ts`（全面置き換え）

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase/server`, `Product`/`ProductInput` from `@/types/product`
- Produces: `listProducts(): Promise<Product[]>`, `getProduct(id: string): Promise<Product | null>`, `createProduct(input: ProductInput): Promise<Product>`, `updateProduct(id: string, input: ProductInput): Promise<Product>`, `deleteProduct(id: string): Promise<void>`

- [ ] **Step 1: repository.ts を Supabase 版で置き換え**

`src/lib/products/repository.ts` を以下の内容で上書き:

```typescript
import { supabase } from '@/lib/supabase/server'
import type { Product, ProductInput } from '@/types/product'

function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    jan: row.jan as string,
    ref: row.ref as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listProducts(): Promise<Product[]> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapProduct)
}

export async function getProduct(id: string): Promise<Product | null> {
  const { data, error } = await supabase
    .from('products')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function createProduct(input: ProductInput): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .insert({ jan: input.jan, ref: input.ref })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function updateProduct(id: string, input: ProductInput): Promise<Product> {
  const { data, error } = await supabase
    .from('products')
    .update({ jan: input.jan, ref: input.ref })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`製品ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('JAN または REF が既に使用されています')
    throw new Error(error.message)
  }
  return mapProduct(data)
}

export async function deleteProduct(id: string): Promise<void> {
  const { error } = await supabase
    .from('products')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
```

- [ ] **Step 2: lint 確認**

```bash
npm run lint
```

- [ ] **Step 3: コミット**

```bash
git add src/lib/products/repository.ts
git commit -m "feat: replace in-memory products repository with Supabase"
```

---

### Task 5: Products API routes + テスト（新スキーマ対応）

**Files:**
- Modify: `src/app/api/products/route.ts`
- Modify: `src/app/api/products/[id]/route.ts`
- Modify: `src/__tests__/api-products.test.ts`

**Interfaces:**
- Consumes: `listProducts`, `getProduct`, `createProduct`, `updateProduct`, `deleteProduct` from `@/lib/products/repository`
- Produces: `GET/POST /api/products`, `GET/PUT/DELETE /api/products/[id]`

- [ ] **Step 1: src/app/api/products/route.ts を新スキーマで上書き**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { listProducts, createProduct } from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

export async function GET() {
  const products = await listProducts()
  return NextResponse.json({ products })
}

export async function POST(request: NextRequest) {
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.jan || !input.ref) {
    return NextResponse.json({ error: 'JAN と REF は必須です' }, { status: 400 })
  }

  try {
    const product = await createProduct(input)
    return NextResponse.json({ product }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: 'JAN または REF が重複しています' }, { status: 409 })
    }
    throw error
  }
}
```

- [ ] **Step 2: src/app/api/products/[id]/route.ts を新スキーマで上書き**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getProduct, updateProduct, deleteProduct } from '@/lib/products/repository'
import type { ProductInput } from '@/types/product'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const product = await getProduct(id)
  if (!product) {
    return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ product })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: ProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.jan || !input.ref) {
    return NextResponse.json({ error: 'JAN と REF は必須です' }, { status: 400 })
  }

  try {
    const product = await updateProduct(id, input)
    return NextResponse.json({ product })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: 'JAN または REF が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteProduct(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '製品が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
```

- [ ] **Step 3: src/__tests__/api-products.test.ts をモック版で上書き**

```typescript
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

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
  createdAt: '2026-06-18T00:00:00Z',
  updatedAt: '2026-06-18T00:00:00Z',
}

function makeRequest(url: string, init?: RequestInit) {
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
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001' }),
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
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-001' }),
    })
    const res = await POST(req)
    expect(res.status).toBe(409)
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
      body: JSON.stringify({ jan: '4901234567890', ref: 'REF-002' }),
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
      body: JSON.stringify({ jan: '1234567890123', ref: 'REF-X' }),
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
})
```

- [ ] **Step 4: テスト実行**

```bash
npm test -- src/__tests__/api-products.test.ts
```

Expected: 全テスト PASS

- [ ] **Step 5: コミット**

```bash
git add src/app/api/products/ src/__tests__/api-products.test.ts
git commit -m "feat: update products API routes and tests for new schema"
```

---

### Task 6: Facilities リポジトリ + API routes

**Files:**
- Create: `src/lib/facilities/repository.ts`
- Create: `src/app/api/facilities/route.ts`
- Create: `src/app/api/facilities/[id]/route.ts`

**Interfaces:**
- Consumes: `supabase`, `Facility`/`FacilityInput` from `@/types/facility`
- Produces: `listFacilities()`, `getFacility(id)`, `createFacility(input)`, `updateFacility(id, input)`, `deleteFacility(id)`; `GET/POST /api/facilities`, `GET/PUT/DELETE /api/facilities/[id]`

- [ ] **Step 1: src/lib/facilities/repository.ts を作成**

```typescript
import { supabase } from '@/lib/supabase/server'
import type { Facility, FacilityInput } from '@/types/facility'

function mapFacility(row: Record<string, unknown>): Facility {
  return {
    id: row.id as string,
    name: row.name as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listFacilities(): Promise<Facility[]> {
  const { data, error } = await supabase
    .from('facilities')
    .select('*')
    .order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return data.map(mapFacility)
}

export async function getFacility(id: string): Promise<Facility | null> {
  const { data, error } = await supabase
    .from('facilities')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function createFacility(input: FacilityInput): Promise<Facility> {
  const { data, error } = await supabase
    .from('facilities')
    .insert({ name: input.name })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function updateFacility(id: string, input: FacilityInput): Promise<Facility> {
  const { data, error } = await supabase
    .from('facilities')
    .update({ name: input.name })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`施設ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error(`施設名 "${input.name}" は既に使用されています`)
    throw new Error(error.message)
  }
  return mapFacility(data)
}

export async function deleteFacility(id: string): Promise<void> {
  const { error } = await supabase
    .from('facilities')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
```

- [ ] **Step 2: src/app/api/facilities/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { listFacilities, createFacility } from '@/lib/facilities/repository'
import type { FacilityInput } from '@/types/facility'

export async function GET() {
  const facilities = await listFacilities()
  return NextResponse.json({ facilities })
}

export async function POST(request: NextRequest) {
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.name) {
    return NextResponse.json({ error: '施設名は必須です' }, { status: 400 })
  }

  try {
    const facility = await createFacility(input)
    return NextResponse.json({ facility }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('既に使用されています')) {
      return NextResponse.json({ error: '施設名が重複しています' }, { status: 409 })
    }
    throw error
  }
}
```

- [ ] **Step 3: src/app/api/facilities/[id]/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getFacility, updateFacility, deleteFacility } from '@/lib/facilities/repository'
import type { FacilityInput } from '@/types/facility'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const facility = await getFacility(id)
  if (!facility) {
    return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ facility })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: FacilityInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.name) {
    return NextResponse.json({ error: '施設名は必須です' }, { status: 400 })
  }

  try {
    const facility = await updateFacility(id, input)
    return NextResponse.json({ facility })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
      }
      if (error.message.includes('既に使用されています')) {
        return NextResponse.json({ error: '施設名が重複しています' }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteFacility(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '施設が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
```

- [ ] **Step 4: lint 確認**

```bash
npm run lint
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/facilities/ src/app/api/facilities/
git commit -m "feat: add facilities repository and API routes"
```

---

### Task 7: Distributor Products リポジトリ + API routes

**Files:**
- Create: `src/lib/distributor-products/repository.ts`
- Create: `src/app/api/distributor-products/route.ts`
- Create: `src/app/api/distributor-products/[id]/route.ts`

**Interfaces:**
- Consumes: `supabase`, `DistributorProduct`/`DistributorProductInput` from `@/types/distributorProduct`
- Produces: `listDistributorProducts()`, `getDistributorProduct(id)`, `createDistributorProduct(input)`, `updateDistributorProduct(id, input)`, `deleteDistributorProduct(id)`; `GET/POST /api/distributor-products`, `GET/PUT/DELETE /api/distributor-products/[id]`

- [ ] **Step 1: src/lib/distributor-products/repository.ts を作成**

```typescript
import { supabase } from '@/lib/supabase/server'
import type { DistributorProduct, DistributorProductInput } from '@/types/distributorProduct'

function mapDistributorProduct(row: Record<string, unknown>): DistributorProduct {
  return {
    id: row.id as string,
    productId: row.product_id as string,
    maker: row.maker as string,
    supplier: row.supplier as string,
    name: row.name as string,
    reimbursementPrice: row.reimbursement_price as number | null,
    quantity: row.quantity as number,
    category: row.category as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listDistributorProducts(): Promise<DistributorProduct[]> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapDistributorProduct)
}

export async function getDistributorProduct(id: string): Promise<DistributorProduct | null> {
  const { data, error } = await supabase
    .from('distributor_products')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function createDistributorProduct(input: DistributorProductInput): Promise<DistributorProduct> {
  const { data, error } = await supabase
    .from('distributor_products')
    .insert({
      product_id: input.productId,
      maker: input.maker,
      supplier: input.supplier,
      name: input.name,
      reimbursement_price: input.reimbursementPrice,
      quantity: input.quantity,
      category: input.category,
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23503') throw new Error(`製品ID "${input.productId}" は存在しません`)
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function updateDistributorProduct(id: string, input: DistributorProductInput): Promise<DistributorProduct> {
  const { data, error } = await supabase
    .from('distributor_products')
    .update({
      product_id: input.productId,
      maker: input.maker,
      supplier: input.supplier,
      name: input.name,
      reimbursement_price: input.reimbursementPrice,
      quantity: input.quantity,
      category: input.category,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`代理店商品ID "${id}" は存在しません`)
    if (error.code === '23503') throw new Error(`製品ID "${input.productId}" は存在しません`)
    throw new Error(error.message)
  }
  return mapDistributorProduct(data)
}

export async function deleteDistributorProduct(id: string): Promise<void> {
  const { error } = await supabase
    .from('distributor_products')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
```

- [ ] **Step 2: src/app/api/distributor-products/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { listDistributorProducts, createDistributorProduct } from '@/lib/distributor-products/repository'
import type { DistributorProductInput } from '@/types/distributorProduct'

export async function GET() {
  const items = await listDistributorProducts()
  return NextResponse.json({ items })
}

export async function POST(request: NextRequest) {
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.category) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const item = await createDistributorProduct(input)
    return NextResponse.json({ item }, { status: 201 })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}
```

- [ ] **Step 3: src/app/api/distributor-products/[id]/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getDistributorProduct, updateDistributorProduct, deleteDistributorProduct } from '@/lib/distributor-products/repository'
import type { DistributorProductInput } from '@/types/distributorProduct'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const item = await getDistributorProduct(id)
  if (!item) {
    return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ item })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: DistributorProductInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.productId || !input.maker || !input.supplier || !input.name || !input.category) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const item = await updateDistributorProduct(id, input)
    return NextResponse.json({ item })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteDistributorProduct(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
```

- [ ] **Step 4: lint 確認**

```bash
npm run lint
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/distributor-products/ src/app/api/distributor-products/
git commit -m "feat: add distributor-products repository and API routes"
```

---

### Task 8: Hospital Prices リポジトリ + API routes

**Files:**
- Create: `src/lib/hospital-prices/repository.ts`
- Create: `src/app/api/hospital-prices/route.ts`
- Create: `src/app/api/hospital-prices/[id]/route.ts`

**Interfaces:**
- Consumes: `supabase`, `HospitalPrice`/`HospitalPriceInput` from `@/types/hospitalPrice`
- Produces: `listHospitalPrices()`, `getHospitalPrice(id)`, `createHospitalPrice(input)`, `updateHospitalPrice(id, input)`, `deleteHospitalPrice(id)`; `GET/POST /api/hospital-prices`, `GET/PUT/DELETE /api/hospital-prices/[id]`

- [ ] **Step 1: src/lib/hospital-prices/repository.ts を作成**

```typescript
import { supabase } from '@/lib/supabase/server'
import type { HospitalPrice, HospitalPriceInput } from '@/types/hospitalPrice'

function mapHospitalPrice(row: Record<string, unknown>): HospitalPrice {
  return {
    id: row.id as string,
    distributorProductId: row.distributor_product_id as string,
    facilityId: row.facility_id as string,
    purchasePrice: row.purchase_price as number,
    deliveryPrice: row.delivery_price as number,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listHospitalPrices(): Promise<HospitalPrice[]> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data.map(mapHospitalPrice)
}

export async function getHospitalPrice(id: string): Promise<HospitalPrice | null> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .select('*')
    .eq('id', id)
    .single()
  if (error) {
    if (error.code === 'PGRST116') return null
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function createHospitalPrice(input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .insert({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .select()
    .single()
  if (error) {
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    if (error.code === '23503') throw new Error('代理店商品または施設が存在しません')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function updateHospitalPrice(id: string, input: HospitalPriceInput): Promise<HospitalPrice> {
  const { data, error } = await supabase
    .from('hospital_prices')
    .update({
      distributor_product_id: input.distributorProductId,
      facility_id: input.facilityId,
      purchase_price: input.purchasePrice,
      delivery_price: input.deliveryPrice,
    })
    .eq('id', id)
    .select()
    .single()
  if (error) {
    if (error.code === 'PGRST116') throw new Error(`病院別価格ID "${id}" は存在しません`)
    if (error.code === '23505') throw new Error('この代理店商品と施設の組み合わせは既に登録されています')
    throw new Error(error.message)
  }
  return mapHospitalPrice(data)
}

export async function deleteHospitalPrice(id: string): Promise<void> {
  const { error } = await supabase
    .from('hospital_prices')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
```

- [ ] **Step 2: src/app/api/hospital-prices/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { listHospitalPrices, createHospitalPrice } from '@/lib/hospital-prices/repository'
import type { HospitalPriceInput } from '@/types/hospitalPrice'

export async function GET() {
  const prices = await listHospitalPrices()
  return NextResponse.json({ prices })
}

export async function POST(request: NextRequest) {
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.deliveryPrice === undefined) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const price = await createHospitalPrice(input)
    return NextResponse.json({ price }, { status: 201 })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 404 })
      }
    }
    throw error
  }
}
```

- [ ] **Step 3: src/app/api/hospital-prices/[id]/route.ts を作成**

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { getHospitalPrice, updateHospitalPrice, deleteHospitalPrice } from '@/lib/hospital-prices/repository'
import type { HospitalPriceInput } from '@/types/hospitalPrice'

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  const price = await getHospitalPrice(id)
  if (!price) {
    return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
  }
  return NextResponse.json({ price })
}

export async function PUT(request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  let input: HospitalPriceInput
  try {
    input = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!input.distributorProductId || !input.facilityId ||
      input.purchasePrice === undefined || input.deliveryPrice === undefined) {
    return NextResponse.json({ error: '必須項目が未入力です' }, { status: 400 })
  }

  try {
    const price = await updateHospitalPrice(id, input)
    return NextResponse.json({ price })
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('存在しません')) {
        return NextResponse.json({ error: error.message }, { status: 404 })
      }
      if (error.message.includes('既に登録されています')) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
    }
    throw error
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params
  try {
    await deleteHospitalPrice(id)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof Error && error.message.includes('存在しません')) {
      return NextResponse.json({ error: '病院別価格が見つかりません' }, { status: 404 })
    }
    throw error
  }
}
```

- [ ] **Step 4: lint 確認**

```bash
npm run lint
```

- [ ] **Step 5: コミット**

```bash
git add src/lib/hospital-prices/ src/app/api/hospital-prices/
git commit -m "feat: add hospital-prices repository and API routes"
```

---

### Task 9: 旧コード削除 + 全テスト確認

**Files:**
- Delete: `src/__tests__/repository.test.ts`
- Delete: `src/__tests__/ProductForm.test.tsx`
- Delete: `src/__tests__/ProductList.test.tsx`
- Delete: `src/__tests__/DeleteConfirmDialog.test.tsx`

**Interfaces:**
- なし（クリーンアップのみ）

- [ ] **Step 1: 旧スキーマ依存テスト・コンポーネントを削除**

```bash
rm src/__tests__/repository.test.ts
rm src/__tests__/ProductForm.test.tsx
rm src/__tests__/ProductList.test.tsx
rm src/__tests__/DeleteConfirmDialog.test.tsx
rm src/components/products/DeleteConfirmDialog.tsx
```

- [ ] **Step 2: 全テスト実行**

```bash
npm test
```

Expected: `smoke.test.ts` と `api-products.test.ts` が PASS、エラーなし

- [ ] **Step 3: ビルド確認**

```bash
npm run build 2>&1 | tail -10
```

Expected: ビルドエラーなし（型エラーが出る場合は Products UI ページが旧型に依存しているため、エラーメッセージを確認して該当箇所を `// @ts-expect-error TODO: update UI` でスキップする）

- [ ] **Step 4: コミット**

```bash
git add -A
git commit -m "chore: remove old schema tests and deprecated files"
```

---

### Task 10: Products UI ページを新スキーマに更新

**Files:**
- Modify: `src/app/products/page.tsx`
- Modify: `src/app/products/new/page.tsx`
- Modify: `src/app/products/[id]/edit/page.tsx`
- Modify: `src/components/products/ProductForm.tsx`
- Modify: `src/components/products/ProductList.tsx`

**Interfaces:**
- Consumes: `Product`/`ProductInput` from `@/types/product`（新スキーマ: jan, ref）

- [ ] **Step 1: src/components/products/ProductForm.tsx を新スキーマで上書き**

```typescript
'use client'

import type { ProductInput } from '@/types/product'

type Props = {
  defaultValues?: Partial<ProductInput>
  action: (formData: FormData) => void
  submitLabel: string
}

export function ProductForm({ defaultValues, action, submitLabel }: Props) {
  return (
    <form action={action} className="flex flex-col gap-4 max-w-md">
      <div>
        <label className="block text-sm font-medium mb-1">JAN コード *</label>
        <input
          name="jan"
          defaultValue={defaultValues?.jan ?? ''}
          required
          className="border rounded px-3 py-2 w-full"
          placeholder="4901234567890"
        />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">REF コード *</label>
        <input
          name="ref"
          defaultValue={defaultValues?.ref ?? ''}
          required
          className="border rounded px-3 py-2 w-full"
          placeholder="REF-001"
        />
      </div>
      <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
        {submitLabel}
      </button>
    </form>
  )
}
```

- [ ] **Step 2: src/components/products/ProductList.tsx を新スキーマで上書き**

```typescript
'use client'

import Link from 'next/link'
import type { Product } from '@/types/product'

type Props = {
  products: Product[]
  onDelete: (id: string) => void
}

export function ProductList({ products, onDelete }: Props) {
  if (products.length === 0) {
    return <p className="text-gray-500">製品が登録されていません。</p>
  }

  return (
    <table className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b bg-gray-50">
          <th className="text-left px-3 py-2">JAN</th>
          <th className="text-left px-3 py-2">REF</th>
          <th className="text-left px-3 py-2">操作</th>
        </tr>
      </thead>
      <tbody>
        {products.map((p) => (
          <tr key={p.id} className="border-b hover:bg-gray-50">
            <td className="px-3 py-2">{p.jan}</td>
            <td className="px-3 py-2">{p.ref}</td>
            <td className="px-3 py-2 flex gap-2">
              <Link href={`/products/${p.id}/edit`} className="text-blue-600 hover:underline">
                編集
              </Link>
              <button onClick={() => onDelete(p.id)} className="text-red-600 hover:underline">
                削除
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 3: src/app/products/page.tsx を新スキーマで上書き**

```typescript
'use client'

import { useEffect, useReducer } from 'react'
import Link from 'next/link'
import { ProductList } from '@/components/products/ProductList'
import type { Product } from '@/types/product'

type State = { products: Product[]; loading: boolean; error: string | null; version: number }
type Action =
  | { type: 'LOADED'; products: Product[] }
  | { type: 'ERROR'; message: string }
  | { type: 'REFRESH' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'LOADED': return { ...state, products: action.products, loading: false, error: null }
    case 'ERROR': return { ...state, loading: false, error: action.message }
    case 'REFRESH': return { ...state, loading: true, version: state.version + 1 }
  }
}

export default function ProductsPage() {
  const [state, dispatch] = useReducer(reducer, { products: [], loading: true, error: null, version: 0 })

  useEffect(() => {
    fetch('/api/products')
      .then((r) => r.json())
      .then((d) => dispatch({ type: 'LOADED', products: d.products }))
      .catch(() => dispatch({ type: 'ERROR', message: '読み込みに失敗しました' }))
  }, [state.version])

  async function handleDelete(id: string) {
    if (!confirm('削除しますか？')) return
    await fetch(`/api/products/${id}`, { method: 'DELETE' })
    dispatch({ type: 'REFRESH' })
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-bold">製品マスタ</h1>
        <Link href="/products/new" className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
          新規登録
        </Link>
      </div>
      {state.loading && <p>読み込み中...</p>}
      {state.error && <p className="text-red-600">{state.error}</p>}
      {!state.loading && !state.error && (
        <ProductList products={state.products} onDelete={handleDelete} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: src/app/products/new/page.tsx を新スキーマで上書き**

```typescript
'use client'

import { useRouter } from 'next/navigation'
import { ProductForm } from '@/components/products/ProductForm'

export default function NewProductPage() {
  const router = useRouter()

  async function handleSubmit(formData: FormData) {
    const body = {
      jan: formData.get('jan') as string,
      ref: formData.get('ref') as string,
    }
    const res = await fetch('/api/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) router.push('/products')
    else alert('登録に失敗しました')
  }

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold mb-4">製品 新規登録</h1>
      <ProductForm action={handleSubmit} submitLabel="登録" />
    </div>
  )
}
```

- [ ] **Step 5: src/app/products/[id]/edit/page.tsx を新スキーマで上書き**

```typescript
'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProductForm } from '@/components/products/ProductForm'
import type { Product } from '@/types/product'

export default function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter()
  const [product, setProduct] = useState<Product | null>(null)
  const [id, setId] = useState<string>('')

  useEffect(() => {
    params.then(({ id }) => {
      setId(id)
      fetch(`/api/products/${id}`)
        .then((r) => r.json())
        .then((d) => setProduct(d.product))
    })
  }, [params])

  async function handleSubmit(formData: FormData) {
    const body = {
      jan: formData.get('jan') as string,
      ref: formData.get('ref') as string,
    }
    const res = await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (res.ok) router.push('/products')
    else alert('更新に失敗しました')
  }

  if (!product) return <div className="p-6">読み込み中...</div>

  return (
    <div className="p-6">
      <h1 className="text-xl font-bold mb-4">製品 編集</h1>
      <ProductForm defaultValues={{ jan: product.jan, ref: product.ref }} action={handleSubmit} submitLabel="更新" />
    </div>
  )
}
```

- [ ] **Step 6: 全テスト + lint + ビルド確認**

```bash
npm test && npm run lint && npm run build 2>&1 | tail -5
```

Expected: テスト PASS、lint エラーなし、ビルド成功

- [ ] **Step 7: コミット**

```bash
git add src/components/products/ src/app/products/
git commit -m "feat: update products UI for new jan/ref schema"
```

---

## 完了条件

- `npm test` 全通過
- `npm run lint` エラーなし
- `npm run build` 成功
- Supabase ダッシュボードの Table Editor で4テーブルが確認できる
- `/products` ページが表示され、JAN/REF での製品登録・編集・削除が動作する
