# 価格履歴機能 実装プラン

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** distributor_products の償還価格と hospital_prices の仕入・配送価格の変更を DBトリガーで自動記録し、専用ページで履歴を確認できるようにする。

**Architecture:** DBトリガー（SECURITY DEFINER）が price_histories テーブルへ自動 INSERT。クエリは Supabase RPC 経由の UNION SQL で実行。Next.js API Route → Repository → UI という既存の3層構造を踏襲する。

**Tech Stack:** Next.js 15 (App Router), Supabase (PostgreSQL + JS client), TypeScript, Tailwind CSS, Vitest

## Global Constraints

- テストフレームワーク: Vitest（`npm test` = `vitest run`）
- Supabase クライアント: `import { supabase } from '@/lib/supabase/server'`
- snake_case（DB）→ camelCase（TypeScript）のマッピングは Repository 層で行う
- DB 権限: anon/authenticated は SELECT のみ。INSERT は SECURITY DEFINER トリガー経由のみ
- 履歴は append-only（削除なし）
- テストファイルは `src/__tests__/` (API) と `src/components/xxx/__tests__/` (UI) に配置
- コミットは各タスク完了時に行う

---

## ファイル構成

| 操作 | ファイル |
|------|---------|
| 新規作成 | `supabase/migrations/20260622000000_add_price_histories.sql` |
| 新規作成 | `src/types/priceHistory.ts` |
| 新規作成 | `src/lib/price-histories/repository.ts` |
| 新規作成 | `src/app/api/distributor-products/[id]/price-history/route.ts` |
| 新規作成 | `src/__tests__/api-price-history.test.ts` |
| 新規作成 | `src/components/price-history/PriceHistoryRow.tsx` |
| 新規作成 | `src/components/price-history/PriceHistoryList.tsx` |
| 新規作成 | `src/components/price-history/__tests__/PriceHistoryList.test.tsx` |
| 新規作成 | `src/app/distributor-products/[id]/price-history/page.tsx` |
| 変更 | `src/app/distributor-products/[id]/edit/page.tsx` |

---

## Task 1: DBマイグレーション

**Files:**
- Create: `supabase/migrations/20260622000000_add_price_histories.sql`

**Interfaces:**
- Produces: `price_histories` テーブル、DBトリガー2本、RPC関数 `get_distributor_product_price_history`

> **設計注記:** 仕様書のスキーマに `distributor_product_id UUID NOT NULL` を追加する。これは `hospital_prices` 削除後も履歴行を親の distributor_product_id で検索できるようにするため。トリガーで INSERT 時にこのカラムを埋める。

- [ ] **Step 1: マイグレーションファイルを作成する**

```sql
-- supabase/migrations/20260622000000_add_price_histories.sql

-- ① price_histories テーブル
CREATE TABLE price_histories (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type            TEXT NOT NULL CHECK (entity_type IN ('distributor_product', 'hospital_price')),
  entity_id              UUID NOT NULL,
  distributor_product_id UUID NOT NULL,
  field_name             TEXT NOT NULL CHECK (field_name IN ('reimbursement_price', 'purchase_price', 'delivery_price')),
  old_value              NUMERIC,
  new_value              NUMERIC,
  changed_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_price_histories_distributor_product ON price_histories (distributor_product_id);
CREATE INDEX idx_price_histories_entity ON price_histories (entity_type, entity_id);

-- ② RLS: anon/authenticated は SELECT のみ。INSERT はトリガー経由（SECURITY DEFINER）
ALTER TABLE price_histories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "price_histories_select" ON price_histories
  FOR SELECT TO anon, authenticated USING (true);

-- INSERT は RLS ポリシーで明示的に拒否（SECURITY DEFINER 関数は RLS をバイパスするため INSERT 可能）
CREATE POLICY "price_histories_no_insert" ON price_histories
  FOR INSERT TO anon, authenticated WITH CHECK (false);

GRANT SELECT ON price_histories TO anon, authenticated, service_role;

-- ③ distributor_products トリガー: reimbursement_price 変更検知
CREATE OR REPLACE FUNCTION trg_distributor_products_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.reimbursement_price IS DISTINCT FROM OLD.reimbursement_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('distributor_product', NEW.id, NEW.id, 'reimbursement_price',
       OLD.reimbursement_price, NEW.reimbursement_price);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER distributor_products_price_history
AFTER UPDATE ON distributor_products
FOR EACH ROW EXECUTE FUNCTION trg_distributor_products_price_history();

-- ④ hospital_prices トリガー: purchase_price / delivery_price 変更検知
CREATE OR REPLACE FUNCTION trg_hospital_prices_price_history()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NEW.purchase_price IS DISTINCT FROM OLD.purchase_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('hospital_price', NEW.id, NEW.distributor_product_id, 'purchase_price',
       OLD.purchase_price, NEW.purchase_price);
  END IF;
  IF NEW.delivery_price IS DISTINCT FROM OLD.delivery_price THEN
    INSERT INTO price_histories
      (entity_type, entity_id, distributor_product_id, field_name, old_value, new_value)
    VALUES
      ('hospital_price', NEW.id, NEW.distributor_product_id, 'delivery_price',
       OLD.delivery_price, NEW.delivery_price);
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER hospital_prices_price_history
AFTER UPDATE ON hospital_prices
FOR EACH ROW EXECUTE FUNCTION trg_hospital_prices_price_history();

-- ⑤ RPC 関数: UNION クエリで distributor_product に紐づく全履歴を返す
CREATE OR REPLACE FUNCTION get_distributor_product_price_history(
  p_distributor_product_id UUID
)
RETURNS TABLE (
  id                     UUID,
  entity_type            TEXT,
  entity_id              UUID,
  distributor_product_id UUID,
  field_name             TEXT,
  old_value              NUMERIC,
  new_value              NUMERIC,
  changed_at             TIMESTAMPTZ,
  facility_name          TEXT
) LANGUAGE sql SECURITY DEFINER AS $$
  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    NULL::TEXT AS facility_name
  FROM price_histories ph
  WHERE ph.entity_type = 'distributor_product'
    AND ph.distributor_product_id = p_distributor_product_id

  UNION ALL

  SELECT
    ph.id, ph.entity_type, ph.entity_id, ph.distributor_product_id,
    ph.field_name, ph.old_value, ph.new_value, ph.changed_at,
    f.name AS facility_name
  FROM price_histories ph
  LEFT JOIN hospital_prices hp ON hp.id = ph.entity_id
  LEFT JOIN facilities f ON f.id = hp.facility_id
  WHERE ph.entity_type = 'hospital_price'
    AND ph.distributor_product_id = p_distributor_product_id

  ORDER BY changed_at DESC;
$$;

GRANT EXECUTE ON FUNCTION get_distributor_product_price_history TO anon, authenticated, service_role;
```

- [ ] **Step 2: Supabase にマイグレーションを適用する**

```bash
npx supabase db push
```

期待出力: `Applying migration 20260622000000_add_price_histories.sql...` → `Done`

エラー時: Supabase Studio で手動 SQL 実行でも可。

- [ ] **Step 3: Supabase Studio でトリガーを手動検証する**

Supabase Studio の SQL Editor で以下を実行し、トリガーが動作することを確認する:

```sql
-- テスト用: distributor_products の reimbursement_price を変更
UPDATE distributor_products
SET reimbursement_price = 9999
WHERE id = (SELECT id FROM distributor_products LIMIT 1);

-- 履歴が記録されたか確認
SELECT * FROM price_histories ORDER BY changed_at DESC LIMIT 5;
```

期待: 1行の price_histories レコードが挿入されている。

```sql
-- 元に戻す
UPDATE distributor_products
SET reimbursement_price = (SELECT reimbursement_price FROM price_histories ORDER BY changed_at DESC LIMIT 1)
WHERE id = (SELECT id FROM distributor_products LIMIT 1);
```

- [ ] **Step 4: コミット**

```bash
git add supabase/migrations/20260622000000_add_price_histories.sql
git commit -m "feat: add price_histories table, triggers, and RPC function"
```

---

## Task 2: 型定義

**Files:**
- Create: `src/types/priceHistory.ts`

**Interfaces:**
- Produces: `PriceHistory`, `PriceHistoryEntityType`, `PriceHistoryFieldName` — Task 3, 4, 5, 6 で使用

- [ ] **Step 1: 型定義ファイルを作成する**

```typescript
// src/types/priceHistory.ts
export type PriceHistoryEntityType = 'distributor_product' | 'hospital_price'

export type PriceHistoryFieldName =
  | 'reimbursement_price'
  | 'purchase_price'
  | 'delivery_price'

export interface PriceHistory {
  id: string
  entityType: PriceHistoryEntityType
  entityId: string
  distributorProductId: string
  fieldName: PriceHistoryFieldName
  oldValue: number | null
  newValue: number | null
  changedAt: string
  facilityName?: string | null
}

export const FIELD_LABEL: Record<PriceHistoryFieldName, string> = {
  reimbursement_price: '償還価格',
  purchase_price: '仕入価格',
  delivery_price: '配送価格',
}

export const ENTITY_LABEL: Record<PriceHistoryEntityType, string> = {
  distributor_product: '償還価格',
  hospital_price: '施設価格',
}
```

- [ ] **Step 2: TypeScript 型チェックで確認する**

```bash
npx tsc --noEmit
```

期待: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/types/priceHistory.ts
git commit -m "feat: add PriceHistory types"
```

---

## Task 3: リポジトリ層

**Files:**
- Create: `src/lib/price-histories/repository.ts`

**Interfaces:**
- Consumes: `supabase` from `@/lib/supabase/server`、`PriceHistory` from `@/types/priceHistory`、RPC `get_distributor_product_price_history`
- Produces: `getPriceHistory(distributorProductId: string): Promise<PriceHistory[]>` — Task 4 で使用

- [ ] **Step 1: リポジトリを作成する**

```typescript
// src/lib/price-histories/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { PriceHistory, PriceHistoryEntityType, PriceHistoryFieldName } from '@/types/priceHistory'

function mapPriceHistory(row: Record<string, unknown>): PriceHistory {
  return {
    id: row.id as string,
    entityType: row.entity_type as PriceHistoryEntityType,
    entityId: row.entity_id as string,
    distributorProductId: row.distributor_product_id as string,
    fieldName: row.field_name as PriceHistoryFieldName,
    oldValue: row.old_value != null ? Number(row.old_value) : null,
    newValue: row.new_value != null ? Number(row.new_value) : null,
    changedAt: row.changed_at as string,
    facilityName: (row.facility_name as string | null) ?? null,
  }
}

export async function getPriceHistory(distributorProductId: string): Promise<PriceHistory[]> {
  const { data, error } = await supabase.rpc(
    'get_distributor_product_price_history',
    { p_distributor_product_id: distributorProductId }
  )
  if (error) throw new Error(error.message)
  return (data as Record<string, unknown>[]).map(mapPriceHistory)
}
```

- [ ] **Step 2: 型チェックで確認する**

```bash
npx tsc --noEmit
```

期待: エラーなし

- [ ] **Step 3: コミット**

```bash
git add src/lib/price-histories/repository.ts
git commit -m "feat: add price-histories repository with RPC query"
```

---

## Task 4: API Route + テスト

**Files:**
- Create: `src/app/api/distributor-products/[id]/price-history/route.ts`
- Create: `src/__tests__/api-price-history.test.ts`

**Interfaces:**
- Consumes: `getPriceHistory` from `@/lib/price-histories/repository`、`getDistributorProduct` from `@/lib/distributor-products/repository`
- Produces: `GET /api/distributor-products/[id]/price-history` → `{ items: PriceHistory[] }` — Task 6 で使用

- [ ] **Step 1: 失敗するテストを書く**

```typescript
// src/__tests__/api-price-history.test.ts
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))
vi.mock('@/lib/price-histories/repository')
vi.mock('@/lib/distributor-products/repository')

import { getPriceHistory } from '@/lib/price-histories/repository'
import { getDistributorProduct } from '@/lib/distributor-products/repository'
import { GET } from '@/app/api/distributor-products/[id]/price-history/route'

const mockHistory = {
  id: 'hist-1',
  entityType: 'distributor_product' as const,
  entityId: 'dp-1',
  distributorProductId: 'dp-1',
  fieldName: 'reimbursement_price' as const,
  oldValue: 1000,
  newValue: 1200,
  changedAt: '2026-06-22T10:00:00Z',
  facilityName: null,
}

const mockProduct = {
  id: 'dp-1',
  productId: 'prod-1',
  maker: 'メーカーA',
  supplier: '仕入先A',
  name: '商品A',
  reimbursementPrice: 1200,
  quantity: 1,
  categoryId: 'cat-1',
  createdAt: '2026-06-22T00:00:00Z',
  updatedAt: '2026-06-22T00:00:00Z',
}

function makeRequest(url: string) {
  return new NextRequest(`http://localhost${url}`)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => vi.resetAllMocks())

describe('GET /api/distributor-products/[id]/price-history', () => {
  it('価格履歴一覧を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockResolvedValue([mockHistory])

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(1)
    expect(body.items[0].fieldName).toBe('reimbursement_price')
    expect(body.items[0].oldValue).toBe(1000)
  })

  it('distributor_product が存在しない場合 404 を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(null)

    const req = makeRequest('/api/distributor-products/nonexistent/price-history')
    const res = await GET(req, makeParams('nonexistent'))

    expect(res.status).toBe(404)
  })

  it('履歴が 0 件のとき空配列を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockResolvedValue([])

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items).toHaveLength(0)
  })

  it('リポジトリがエラーを投げた場合 500 を返す', async () => {
    vi.mocked(getDistributorProduct).mockResolvedValue(mockProduct)
    vi.mocked(getPriceHistory).mockRejectedValue(new Error('DB error'))

    const req = makeRequest('/api/distributor-products/dp-1/price-history')
    const res = await GET(req, makeParams('dp-1'))

    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test src/__tests__/api-price-history.test.ts
```

期待: `FAIL` — route.ts が存在しないため

- [ ] **Step 3: API Route を実装する**

```typescript
// src/app/api/distributor-products/[id]/price-history/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { getPriceHistory } from '@/lib/price-histories/repository'
import { getDistributorProduct } from '@/lib/distributor-products/repository'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  try {
    const product = await getDistributorProduct(id)
    if (!product) {
      return NextResponse.json({ error: '代理店商品が見つかりません' }, { status: 404 })
    }

    const items = await getPriceHistory(id)
    return NextResponse.json({ items })
  } catch (err) {
    const message = err instanceof Error ? err.message : '不明なエラー'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test src/__tests__/api-price-history.test.ts
```

期待: `PASS` — 4テスト全て緑

- [ ] **Step 5: 全テストが壊れていないことを確認する**

```bash
npm test
```

期待: 全テスト PASS

- [ ] **Step 6: コミット**

```bash
git add src/app/api/distributor-products/[id]/price-history/route.ts \
        src/__tests__/api-price-history.test.ts
git commit -m "feat: add GET /api/distributor-products/[id]/price-history"
```

---

## Task 5: UIコンポーネント + テスト

**Files:**
- Create: `src/components/price-history/PriceHistoryRow.tsx`
- Create: `src/components/price-history/PriceHistoryList.tsx`
- Create: `src/components/price-history/__tests__/PriceHistoryList.test.tsx`

**Interfaces:**
- Consumes: `PriceHistory`, `FIELD_LABEL`, `ENTITY_LABEL` from `@/types/priceHistory`
- Produces: `<PriceHistoryList items={PriceHistory[]} />` — Task 6 で使用

- [ ] **Step 1: 失敗するテストを書く**

```typescript
// src/components/price-history/__tests__/PriceHistoryList.test.tsx
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { PriceHistoryList } from '../PriceHistoryList'
import type { PriceHistory } from '@/types/priceHistory'

const mockItems: PriceHistory[] = [
  {
    id: 'hist-1',
    entityType: 'distributor_product',
    entityId: 'dp-1',
    distributorProductId: 'dp-1',
    fieldName: 'reimbursement_price',
    oldValue: 1000,
    newValue: 1200,
    changedAt: '2026-06-22T10:00:00Z',
    facilityName: null,
  },
  {
    id: 'hist-2',
    entityType: 'hospital_price',
    entityId: 'hp-1',
    distributorProductId: 'dp-1',
    fieldName: 'purchase_price',
    oldValue: 800,
    newValue: 900,
    changedAt: '2026-06-21T09:00:00Z',
    facilityName: 'A病院',
  },
]

describe('PriceHistoryList', () => {
  it('変更前・後・種別を一覧表示する', () => {
    render(<PriceHistoryList items={mockItems} />)
    expect(screen.getByText('¥1,000')).toBeInTheDocument()
    expect(screen.getByText('¥1,200')).toBeInTheDocument()
    expect(screen.getByText('施設価格（A病院）')).toBeInTheDocument()
  })

  it('0 件のとき「変更履歴はありません」を表示する', () => {
    render(<PriceHistoryList items={[]} />)
    expect(screen.getByText('変更履歴はありません')).toBeInTheDocument()
  })

  it('行をクリックすると詳細が展開される', () => {
    render(<PriceHistoryList items={mockItems} />)
    const row = screen.getByText('¥1,000').closest('tr')!
    fireEvent.click(row)
    expect(screen.getByText('hist-1')).toBeInTheDocument()
  })

  it('施設が削除済みの場合「施設情報なし」と表示する', () => {
    const items: PriceHistory[] = [
      {
        ...mockItems[1],
        facilityName: null,
      },
    ]
    render(<PriceHistoryList items={items} />)
    expect(screen.getByText('施設価格（施設情報なし）')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test src/components/price-history/__tests__/PriceHistoryList.test.tsx
```

期待: `FAIL` — コンポーネントが存在しないため

- [ ] **Step 3: PriceHistoryRow を実装する**

```tsx
// src/components/price-history/PriceHistoryRow.tsx
import type { PriceHistory } from '@/types/priceHistory'
import { FIELD_LABEL, ENTITY_LABEL } from '@/types/priceHistory'

function formatPrice(value: number | null): string {
  if (value === null) return '—'
  return `¥${value.toLocaleString('ja-JP')}`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function entityLabel(item: PriceHistory): string {
  if (item.entityType === 'distributor_product') return ENTITY_LABEL.distributor_product
  const name = item.facilityName ?? '施設情報なし'
  return `施設価格（${name}）`
}

interface Props {
  item: PriceHistory
  isOpen: boolean
  onToggle: () => void
}

export function PriceHistoryRow({ item, isOpen, onToggle }: Props) {
  return (
    <>
      <tr
        className="cursor-pointer hover:bg-gray-50"
        onClick={onToggle}
      >
        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
          {formatDate(item.changedAt)}
        </td>
        <td className="px-4 py-3 text-sm text-gray-900">
          {entityLabel(item)}
        </td>
        <td className="px-4 py-3 text-sm text-gray-500">
          {item.entityType === 'hospital_price' ? FIELD_LABEL[item.fieldName] : '—'}
        </td>
        <td className="px-4 py-3 text-sm text-gray-900 text-right">
          {formatPrice(item.oldValue)}
        </td>
        <td className="px-4 py-3 text-sm font-medium text-gray-900 text-right">
          {formatPrice(item.newValue)}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-gray-50">
          <td colSpan={5} className="px-6 py-4">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <dt className="text-gray-500">種別</dt>
              <dd className="text-gray-900">{ENTITY_LABEL[item.entityType]}</dd>
              <dt className="text-gray-500">レコード ID</dt>
              <dd className="font-mono text-xs text-gray-700 break-all">{item.entityId}</dd>
              {item.facilityName !== undefined && (
                <>
                  <dt className="text-gray-500">施設名</dt>
                  <dd className="text-gray-900">{item.facilityName ?? '施設情報なし'}</dd>
                </>
              )}
              <dt className="text-gray-500">フィールド</dt>
              <dd className="text-gray-900">{FIELD_LABEL[item.fieldName]}</dd>
              <dt className="text-gray-500">変更前</dt>
              <dd className="text-gray-900">{formatPrice(item.oldValue)}</dd>
              <dt className="text-gray-500">変更後</dt>
              <dd className="font-medium text-gray-900">{formatPrice(item.newValue)}</dd>
              <dt className="text-gray-500">変更日時</dt>
              <dd className="text-gray-900">{formatDate(item.changedAt)}</dd>
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}
```

- [ ] **Step 4: PriceHistoryList を実装する**

```tsx
// src/components/price-history/PriceHistoryList.tsx
'use client'

import { useState } from 'react'
import type { PriceHistory } from '@/types/priceHistory'
import { PriceHistoryRow } from './PriceHistoryRow'

interface Props {
  items: PriceHistory[]
}

export function PriceHistoryList({ items }: Props) {
  const [openId, setOpenId] = useState<string | null>(null)

  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-gray-500">変更履歴はありません</p>
    )
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-gray-200">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">日時</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">種別</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">フィールド</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">変更前</th>
            <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">変更後</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {items.map((item) => (
            <PriceHistoryRow
              key={item.id}
              item={item}
              isOpen={openId === item.id}
              onToggle={() => setOpenId(openId === item.id ? null : item.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm test src/components/price-history/__tests__/PriceHistoryList.test.tsx
```

期待: `PASS` — 4テスト全て緑

- [ ] **Step 6: 全テストが壊れていないことを確認する**

```bash
npm test
```

期待: 全テスト PASS

- [ ] **Step 7: コミット**

```bash
git add src/components/price-history/
git commit -m "feat: add PriceHistoryList and PriceHistoryRow components"
```

---

## Task 6: 履歴ページ + 編集ページのリンク追加

**Files:**
- Create: `src/app/distributor-products/[id]/price-history/page.tsx`
- Modify: `src/app/distributor-products/[id]/edit/page.tsx:76-78`

**Interfaces:**
- Consumes: `GET /api/distributor-products/[id]/price-history`（Task 4）、`<PriceHistoryList />`（Task 5）

- [ ] **Step 1: 履歴ページを作成する**

```tsx
// src/app/distributor-products/[id]/price-history/page.tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { PriceHistory } from '@/types/priceHistory'
import { PriceHistoryList } from '@/components/price-history/PriceHistoryList'

export default function PriceHistoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [items, setItems] = useState<PriceHistory[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/distributor-products/${id}/price-history`)
      .then((r) => {
        if (!r.ok) throw new Error('履歴の取得に失敗しました')
        return r.json()
      })
      .then((data) => {
        if (!cancelled) setItems(data.items)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [id])

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link
        href={`/distributor-products/${id}/edit`}
        className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800"
      >
        &larr; 編集に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">価格変更履歴</h1>

      {loading && (
        <p className="py-8 text-center text-sm text-gray-500">読み込み中...</p>
      )}

      {error && (
        <p className="py-4 text-center text-sm text-red-600">{error}</p>
      )}

      {!loading && !error && (
        <PriceHistoryList items={items} />
      )}
    </div>
  )
}
```

- [ ] **Step 2: 編集ページに「価格履歴を見る」リンクを追加する**

`src/app/distributor-products/[id]/edit/page.tsx` の74行目付近を変更する（`<Link href="/distributor-products" ...>` の直後に追加）:

```tsx
// 変更前（74-78行目）
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/distributor-products" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>

// 変更後
  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <div className="mb-4 flex items-center justify-between">
        <Link href="/distributor-products" className="text-sm text-blue-600 hover:text-blue-800">
          &larr; 一覧に戻る
        </Link>
        <Link href={`/distributor-products/${id}/price-history`} className="text-sm text-blue-600 hover:text-blue-800">
          価格履歴を見る →
        </Link>
      </div>
```

- [ ] **Step 3: 型チェックと全テストを実行する**

```bash
npx tsc --noEmit && npm test
```

期待: エラーなし、全テスト PASS

- [ ] **Step 4: 動作確認（開発サーバー起動）**

```bash
npm run dev
```

以下の手順で確認する:

1. `http://localhost:3000/distributor-products` を開く
2. 任意の商品の「編集」を開く → 「価格履歴を見る →」リンクが右上に表示されることを確認
3. リンクをクリック → `/distributor-products/[id]/price-history` に遷移することを確認
4. 履歴ページで「変更履歴はありません」または既存履歴が表示されることを確認
5. 編集ページで reimbursement_price を変更して保存 → 履歴ページをリロードして行が追加されることを確認
6. 行をクリックして詳細が展開されることを確認

- [ ] **Step 5: コミット**

```bash
git add src/app/distributor-products/[id]/price-history/page.tsx \
        src/app/distributor-products/[id]/edit/page.tsx
git commit -m "feat: add price history page and link from edit page"
```

---

## 完了チェックリスト

- [ ] `npm test` が全て PASS
- [ ] `npx tsc --noEmit` がエラーなし
- [ ] 開発サーバーで価格を変更 → 履歴ページで変更が記録されていることを確認
- [ ] 行クリックで詳細パネルが展開されることを確認
- [ ] 編集ページの「価格履歴を見る」リンクが機能することを確認
