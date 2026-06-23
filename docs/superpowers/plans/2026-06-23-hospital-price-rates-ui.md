# Hospital Price Rates UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `HospitalPriceList` に仕入れ掛け率・納入掛け率の列を追加し、粗利もDBの生成列値を使うように切り替える。

**Architecture:** DBには `gross_profit`（生成列）・`purchase_rate`・`delivery_rate` が既に存在しマイグレーション済み。型定義 → リポジトリマッピング → UIコンポーネントの順に変更する。TDD: テストを先に書いてからコードを変更する。

**Tech Stack:** TypeScript, React, Vitest, @testing-library/react, Supabase

## Global Constraints

- テストコマンド: `npm test`
- `purchaseRate` / `deliveryRate` は DB 上 `purchase_price / reimbursement_price`（0〜1の小数）として格納される → UI 表示時に ×100 して % 表示
- `reimbursement_price` が未設定の場合、`purchase_rate` / `delivery_rate` は NULL → 「—」表示
- 掛け率は小数点1桁（例: `80.0%`）

---

### Task 1: 型定義 + テストフィクスチャ更新

**Files:**
- Modify: `src/types/hospitalPrice.ts`
- Modify: `src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx`

**Interfaces:**
- Produces: `HospitalPrice` 型に `grossProfit: number`・`purchaseRate: number | null`・`deliveryRate: number | null` が加わる

- [ ] **Step 1: 型定義を更新する**

`src/types/hospitalPrice.ts` を以下に置き換える:

```ts
export type HospitalPrice = {
  id: string
  distributorProductId: string
  facilityId: string
  purchasePrice: number
  deliveryPrice: number
  grossProfit: number
  purchaseRate: number | null
  deliveryRate: number | null
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

- [ ] **Step 2: テストが型エラーで失敗することを確認する**

```bash
npm test -- --reporter=verbose 2>&1 | head -40
```

Expected: TypeScript エラー（`grossProfit`, `purchaseRate`, `deliveryRate` が fixtures に不足）

- [ ] **Step 3: テストフィクスチャに新フィールドを追加する**

`src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx` の `prices` 定義を以下に置き換える:

```ts
const prices: (HospitalPrice & { facilityName: string; productName: string })[] = [
  {
    id: '1',
    distributorProductId: 'dp1',
    facilityId: 'f1',
    purchasePrice: 1000,
    deliveryPrice: 1500,
    grossProfit: 500,
    purchaseRate: 0.8,
    deliveryRate: 0.96,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    facilityName: '中央病院',
    productName: 'カテーテルA',
  },
  {
    id: '2',
    distributorProductId: 'dp2',
    facilityId: 'f2',
    purchasePrice: 20000,
    deliveryPrice: 25000,
    grossProfit: 5000,
    purchaseRate: null,
    deliveryRate: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    facilityName: '東クリニック',
    productName: 'ガーゼB',
  },
]
```

- [ ] **Step 4: テストが通過することを確認する**

```bash
npm test -- --reporter=verbose 2>&1 | head -40
```

Expected: PASS（既存の5テストすべて通過）

- [ ] **Step 5: コミット**

```bash
git add src/types/hospitalPrice.ts src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx
git commit -m "feat: add grossProfit/purchaseRate/deliveryRate fields to HospitalPrice type"
```

---

### Task 2: リポジトリ更新（mapHospitalPrice）

**Files:**
- Modify: `src/lib/hospital-prices/repository.ts`

**Interfaces:**
- Consumes: `HospitalPrice` 型（Task 1 で定義済み）
- Produces: `listHospitalPrices()` / `getHospitalPrice()` が `grossProfit`・`purchaseRate`・`deliveryRate` を返す

- [ ] **Step 1: mapHospitalPrice を更新する**

`src/lib/hospital-prices/repository.ts` の `mapHospitalPrice` 関数を以下に置き換える:

```ts
function mapHospitalPrice(row: Record<string, unknown>): HospitalPrice {
  return {
    id: row.id as string,
    distributorProductId: row.distributor_product_id as string,
    facilityId: row.facility_id as string,
    purchasePrice: Number(row.purchase_price),
    deliveryPrice: Number(row.delivery_price),
    grossProfit: Number(row.gross_profit),
    purchaseRate: row.purchase_rate != null ? Number(row.purchase_rate) : null,
    deliveryRate: row.delivery_rate != null ? Number(row.delivery_rate) : null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}
```

- [ ] **Step 2: テストが通過することを確認する**

```bash
npm test -- --reporter=verbose 2>&1 | tail -20
```

Expected: PASS

- [ ] **Step 3: コミット**

```bash
git add src/lib/hospital-prices/repository.ts
git commit -m "feat: map gross_profit/purchase_rate/delivery_rate in mapHospitalPrice"
```

---

### Task 3: UI コンポーネント更新（掛け率列追加）

**Files:**
- Modify: `src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx`
- Modify: `src/components/hospitalPrices/HospitalPriceList.tsx`

**Interfaces:**
- Consumes: `HospitalPrice.grossProfit`・`purchaseRate`・`deliveryRate`（Task 1 で定義済み）

- [ ] **Step 1: 失敗するテストを書く**

`src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx` の既存テストを以下のように更新・追加する（ファイル全体を置き換える）:

```ts
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HospitalPriceList } from '../HospitalPriceList'
import type { HospitalPrice } from '@/types/hospitalPrice'

const prices: (HospitalPrice & { facilityName: string; productName: string })[] = [
  {
    id: '1',
    distributorProductId: 'dp1',
    facilityId: 'f1',
    purchasePrice: 1000,
    deliveryPrice: 1500,
    grossProfit: 500,
    purchaseRate: 0.8,
    deliveryRate: 0.96,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    facilityName: '中央病院',
    productName: 'カテーテルA',
  },
  {
    id: '2',
    distributorProductId: 'dp2',
    facilityId: 'f2',
    purchasePrice: 20000,
    deliveryPrice: 25000,
    grossProfit: 5000,
    purchaseRate: null,
    deliveryRate: null,
    createdAt: '2026-02-01T00:00:00Z',
    updatedAt: '2026-02-01T00:00:00Z',
    facilityName: '東クリニック',
    productName: 'ガーゼB',
  },
]

describe('HospitalPriceList', () => {
  it('価格一覧が表示される（施設名・商品名・仕切値・納品価格）', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('中央病院')).toBeInTheDocument()
    expect(screen.getByText('カテーテルA')).toBeInTheDocument()
    expect(screen.getByText('1,000')).toBeInTheDocument()
    expect(screen.getByText('1,500')).toBeInTheDocument()
    expect(screen.getByText('東クリニック')).toBeInTheDocument()
    expect(screen.getByText('ガーゼB')).toBeInTheDocument()
    expect(screen.getByText('20,000')).toBeInTheDocument()
    expect(screen.getByText('25,000')).toBeInTheDocument()
  })

  it('粗利がDBの値（grossProfit）で表示される', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('500')).toBeInTheDocument()
    expect(screen.getByText('5,000')).toBeInTheDocument()
  })

  it('掛け率が数値のとき % 表示される（小数点1桁）', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getAllByText('80.0%')).toHaveLength(1)
    expect(screen.getAllByText('96.0%')).toHaveLength(1)
  })

  it('掛け率が null のとき「—」が表示される', () => {
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={vi.fn()} />)
    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(2)
  })

  it('空のとき「価格情報が登録されていません」が表示される', () => {
    render(<HospitalPriceList prices={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('価格情報が登録されていません')).toBeInTheDocument()
  })

  it('編集ボタンクリックで onEdit が呼ばれる', async () => {
    const onEdit = vi.fn()
    render(<HospitalPriceList prices={prices} onEdit={onEdit} onDelete={vi.fn()} />)
    await userEvent.click(screen.getAllByText('編集')[0])
    expect(onEdit).toHaveBeenCalledWith('1')
  })

  it('削除ボタンクリックで onDelete が呼ばれる', async () => {
    const onDelete = vi.fn()
    render(<HospitalPriceList prices={prices} onEdit={vi.fn()} onDelete={onDelete} />)
    await userEvent.click(screen.getAllByText('削除')[0])
    expect(onDelete).toHaveBeenCalledWith('1')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose 2>&1 | grep -A 5 "FAIL\|●"
```

Expected: `掛け率が数値のとき % 表示される` と `掛け率が null のとき「—」が表示される` の2件が FAIL

- [ ] **Step 3: HospitalPriceList コンポーネントを更新する**

`src/components/hospitalPrices/HospitalPriceList.tsx` を以下に置き換える:

```tsx
'use client'

import type { HospitalPrice } from '@/types/hospitalPrice'

type HospitalPriceListProps = {
  prices: (HospitalPrice & { facilityName: string; productName: string })[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

function formatRate(rate: number | null): string {
  if (rate == null) return '—'
  return `${(rate * 100).toFixed(1)}%`
}

export function HospitalPriceList({ prices, onEdit, onDelete }: HospitalPriceListProps) {
  if (prices.length === 0) {
    return (
      <p className="text-center text-gray-500 py-8">
        価格情報が登録されていません
      </p>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">施設名</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">商品名</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">仕切値（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">納品価格（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">粗利（円）</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">仕入れ掛け率</th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">納入掛け率</th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">操作</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {prices.map((price) => (
            <tr key={price.id}>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{price.facilityName}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{price.productName}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.purchasePrice.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.deliveryPrice.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{price.grossProfit.toLocaleString()}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatRate(price.purchaseRate)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm text-right text-gray-900">{formatRate(price.deliveryRate)}</td>
              <td className="px-6 py-4 whitespace-nowrap text-sm space-x-2">
                <button
                  onClick={() => onEdit(price.id)}
                  className="text-indigo-600 hover:text-indigo-900 font-medium"
                >
                  編集
                </button>
                <button
                  onClick={() => onDelete(price.id)}
                  className="text-red-600 hover:text-red-900 font-medium"
                >
                  削除
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
```

- [ ] **Step 4: テストがすべて通過することを確認する**

```bash
npm test -- --reporter=verbose 2>&1 | tail -30
```

Expected: PASS（7件すべて通過）

- [ ] **Step 5: コミット**

```bash
git add src/components/hospitalPrices/HospitalPriceList.tsx src/components/hospitalPrices/__tests__/HospitalPriceList.test.tsx
git commit -m "feat: add purchase_rate and delivery_rate columns to HospitalPriceList"
```
