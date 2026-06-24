# 施設詳細ページ 発注・処理ボタン 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 施設詳細ページに症例発注・消耗品発注・短貸発注・短貸返却・長貸し処理の5ボタンとモーダルUIを追加し、各発注データをSupabaseに保存する。

**Architecture:** 発注種別ごとに専用テーブル・Repository・API route・Modalを持つ縦割り設計。Wave 1でDB/型/共通部品、Wave 2で各発注種別を並列実装、Wave 3で統合する。

**Tech Stack:** Next.js 14 App Router, TypeScript, Supabase (PostgreSQL), Vitest, React Testing Library, userEvent

## Global Constraints
- テスト: `npm test`、Lint: `npm run lint`
- Supabase mockパターン: `vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))` + `beforeEach`で`(supabase as Record<string,unknown>).from = vi.fn(...)`
- スタイル: `#072C2C`（ダークグリーン）、`#FF5F03`（オレンジ）、`#E5E7EB`（ボーダー）、`#6B7280`（グレー）、`#DC2626`（エラー赤）、`var(--font-oswald)`、`var(--font-ubuntu-mono)`
- 全コミット末尾: `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`
- Wave 2のTask 3〜6は互いに独立しており**並列実装可能**（共有ファイルを触らない）

---

### Task 1: DBマイグレーション

**Files:**
- Create: `supabase/migrations/20260624000000_add_orders.sql`

**Interfaces:**
- Produces: `case_orders`, `case_order_items`, `consumables`, `consumable_orders`, `consumable_order_items`, `loan_orders`, `loan_order_items`, `loan_returns`, `loan_return_items` テーブル

- [ ] **Step 1: マイグレーションファイルを作成する**

```sql
-- supabase/migrations/20260624000000_add_orders.sql

-- 症例発注
CREATE TABLE case_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  case_datetime TIMESTAMPTZ NOT NULL,
  procedure_name TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  patient_initials TEXT NOT NULL,
  gender TEXT NOT NULL CHECK (gender IN ('male', 'female', 'other')),
  doctor_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER case_orders_updated_at
  BEFORE UPDATE ON case_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE case_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_order_id UUID NOT NULL REFERENCES case_orders(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 消耗品カタログ
CREATE TABLE consumables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  jan TEXT,
  purpose TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER consumables_updated_at
  BEFORE UPDATE ON consumables
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

-- 消耗品発注
CREATE TABLE consumable_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER consumable_orders_updated_at
  BEFORE UPDATE ON consumable_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE consumable_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  consumable_order_id UUID NOT NULL REFERENCES consumable_orders(id) ON DELETE CASCADE,
  consumable_id UUID NOT NULL REFERENCES consumables(id),
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸発注
CREATE TABLE loan_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  procedure_name TEXT NOT NULL,
  maker TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER loan_orders_updated_at
  BEFORE UPDATE ON loan_orders
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE loan_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_order_id UUID NOT NULL REFERENCES loan_orders(id) ON DELETE CASCADE,
  jan TEXT,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 短貸返却
CREATE TABLE loan_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  facility_id UUID NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
  return_datetime TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'returned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER loan_returns_updated_at
  BEFORE UPDATE ON loan_returns
  FOR EACH ROW EXECUTE PROCEDURE update_updated_at();

CREATE TABLE loan_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_return_id UUID NOT NULL REFERENCES loan_returns(id) ON DELETE CASCADE,
  jan TEXT NOT NULL,
  lot TEXT,
  ubd TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- パーミッション
GRANT ALL ON TABLE public.case_orders           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.case_order_items      TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumables           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumable_orders     TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.consumable_order_items TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_orders           TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_order_items      TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_returns          TO postgres, anon, authenticated, service_role;
GRANT ALL ON TABLE public.loan_return_items     TO postgres, anon, authenticated, service_role;
```

- [ ] **Step 2: リモートDBに適用する**

```bash
npx supabase db push
```

Expected: `Applying migration 20260624000000_add_orders.sql...` と表示されエラーなし。

- [ ] **Step 3: コミット**

```bash
git add supabase/migrations/20260624000000_add_orders.sql
git commit -m "feat: add order tables migration

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: 型定義 + ItemRowInput共通コンポーネント

**Files:**
- Create: `src/types/order.ts`
- Create: `src/components/orders/ItemRowInput.tsx`
- Create: `src/components/orders/__tests__/ItemRowInput.test.tsx`

**Interfaces:**
- Produces:
  - `CaseOrderInput`, `CaseOrderItemInput`, `Consumable`, `ConsumableInput`, `ConsumableOrder`, `ConsumableOrderInput`, `ConsumableOrderItemInput`, `LoanOrderInput`, `LoanOrderItemInput`, `LoanReturnInput`, `LoanReturnItemInput` 型
  - `ItemRow` 型と `ItemRowInput` コンポーネント（`rows: ItemRow[]`, `onChange: (rows: ItemRow[]) => void` propsを持つ）

- [ ] **Step 1: 型定義ファイルを作成する**

```typescript
// src/types/order.ts

export type CaseOrder = {
  id: string
  facilityId: string
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  status: 'draft' | 'submitted'
  items: CaseOrderItem[]
  createdAt: string
  updatedAt: string
}

export type CaseOrderItem = {
  id: string
  caseOrderId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type CaseOrderInput = {
  caseDatetime: string
  procedureName: string
  patientId: string
  patientInitials: string
  gender: 'male' | 'female' | 'other'
  doctorName: string
  items: CaseOrderItemInput[]
}

export type CaseOrderItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}

export type Consumable = {
  id: string
  facilityId: string
  name: string
  jan?: string
  purpose: string
  createdAt: string
  updatedAt: string
}

export type ConsumableInput = {
  name: string
  jan?: string
  purpose: string
}

export type ConsumableOrder = {
  id: string
  facilityId: string
  status: 'draft' | 'submitted'
  items: ConsumableOrderItem[]
  createdAt: string
  updatedAt: string
}

export type ConsumableOrderItem = {
  id: string
  consumableOrderId: string
  consumableId: string
  quantity: number
  createdAt: string
}

export type ConsumableOrderInput = {
  items: ConsumableOrderItemInput[]
}

export type ConsumableOrderItemInput = {
  consumableId: string
  quantity: number
}

export type LoanOrder = {
  id: string
  facilityId: string
  procedureName: string
  maker: string
  status: 'draft' | 'submitted'
  items: LoanOrderItem[]
  createdAt: string
  updatedAt: string
}

export type LoanOrderItem = {
  id: string
  loanOrderId: string
  jan?: string
  name: string
  quantity: number
  createdAt: string
}

export type LoanOrderInput = {
  procedureName: string
  maker: string
  items: LoanOrderItemInput[]
}

export type LoanOrderItemInput = {
  jan?: string
  name: string
  quantity: number
}

export type LoanReturn = {
  id: string
  facilityId: string
  returnDatetime: string
  status: 'draft' | 'returned'
  items: LoanReturnItem[]
  createdAt: string
  updatedAt: string
}

export type LoanReturnItem = {
  id: string
  loanReturnId: string
  jan: string
  lot?: string
  ubd?: string
  quantity: number
  createdAt: string
}

export type LoanReturnInput = {
  returnDatetime: string
  items: LoanReturnItemInput[]
}

export type LoanReturnItemInput = {
  jan: string
  lot?: string
  ubd?: string
  quantity: number
}
```

- [ ] **Step 2: ItemRowInputのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/ItemRowInput.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ItemRowInput, type ItemRow } from '../ItemRowInput'

describe('ItemRowInput', () => {
  const defaultRows: ItemRow[] = [{ jan: '', lot: '', ubd: '', quantity: 1 }]

  it('初期行のJAN/LOT/UBD/数量フィールドが表示される', () => {
    render(<ItemRowInput rows={defaultRows} onChange={vi.fn()} />)
    expect(screen.getByPlaceholderText('JAN')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('LOT')).toBeInTheDocument()
    expect(screen.getByPlaceholderText('UBD')).toBeInTheDocument()
  })

  it('「+ 行を追加」クリックでonChangeが2行配列で呼ばれる', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: '+ 行を追加' }))
    expect(onChange).toHaveBeenCalledWith([
      { jan: '', lot: '', ubd: '', quantity: 1 },
      { jan: '', lot: '', ubd: '', quantity: 1 },
    ])
  })

  it('JANフィールドへの入力でonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    render(<ItemRowInput rows={defaultRows} onChange={onChange} />)
    await userEvent.type(screen.getByPlaceholderText('JAN'), 'A')
    expect(onChange).toHaveBeenLastCalledWith([{ jan: 'A', lot: '', ubd: '', quantity: 1 }])
  })

  it('削除ボタンで行が取り除かれたonChangeが呼ばれる', async () => {
    const onChange = vi.fn()
    const rows: ItemRow[] = [
      { jan: 'A', lot: '', ubd: '', quantity: 1 },
      { jan: 'B', lot: '', ubd: '', quantity: 2 },
    ]
    render(<ItemRowInput rows={rows} onChange={onChange} />)
    const deleteButtons = screen.getAllByRole('button', { name: '削除' })
    await userEvent.click(deleteButtons[0])
    expect(onChange).toHaveBeenCalledWith([{ jan: 'B', lot: '', ubd: '', quantity: 2 }])
  })
})
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/ItemRowInput.test.tsx
```

Expected: FAIL（ItemRowInput が存在しない）

- [ ] **Step 4: ItemRowInputを実装する**

```typescript
// src/components/orders/ItemRowInput.tsx
'use client'

export type ItemRow = {
  jan: string
  lot: string
  ubd: string
  quantity: number
}

type Props = {
  rows: ItemRow[]
  onChange: (rows: ItemRow[]) => void
}

export function ItemRowInput({ rows, onChange }: Props) {
  const addRow = () => onChange([...rows, { jan: '', lot: '', ubd: '', quantity: 1 }])
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: keyof ItemRow, value: string | number) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  return (
    <div>
      <div className="flex gap-2 mb-1 px-1">
        <span className="text-xs font-semibold w-36" style={{ color: '#6B7280' }}>JAN</span>
        <span className="text-xs font-semibold w-28" style={{ color: '#6B7280' }}>LOT</span>
        <span className="text-xs font-semibold w-24" style={{ color: '#6B7280' }}>UBD</span>
        <span className="text-xs font-semibold w-16" style={{ color: '#6B7280' }}>数量</span>
      </div>
      {rows.map((row, i) => (
        <div key={i} className="flex gap-2 mb-2 items-center">
          <input
            type="text"
            value={row.jan}
            onChange={e => updateRow(i, 'jan', e.target.value)}
            placeholder="JAN"
            className="border rounded px-2 py-1 text-sm w-36"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="text"
            value={row.lot}
            onChange={e => updateRow(i, 'lot', e.target.value)}
            placeholder="LOT"
            className="border rounded px-2 py-1 text-sm w-28"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="text"
            value={row.ubd}
            onChange={e => updateRow(i, 'ubd', e.target.value)}
            placeholder="UBD"
            className="border rounded px-2 py-1 text-sm w-24"
            style={{ borderColor: '#E5E7EB' }}
          />
          <input
            type="number"
            value={row.quantity}
            onChange={e => updateRow(i, 'quantity', Number(e.target.value))}
            min={1}
            className="border rounded px-2 py-1 text-sm w-16"
            style={{ borderColor: '#E5E7EB' }}
          />
          <button
            type="button"
            onClick={() => removeRow(i)}
            className="text-sm px-2 py-1"
            style={{ color: '#DC2626' }}
          >
            削除
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addRow}
        className="text-sm px-3 py-1 rounded border"
        style={{ borderColor: '#072C2C', color: '#072C2C' }}
      >
        + 行を追加
      </button>
    </div>
  )
}
```

- [ ] **Step 5: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/ItemRowInput.test.tsx
```

Expected: PASS（4件）

- [ ] **Step 6: コミット**

```bash
git add src/types/order.ts src/components/orders/ItemRowInput.tsx src/components/orders/__tests__/ItemRowInput.test.tsx
git commit -m "feat: add order types and ItemRowInput component

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 3: 症例発注（Repository + API + Modal）[PARALLEL: Wave 2]

**Files:**
- Create: `src/lib/case-orders/repository.ts`
- Create: `src/lib/case-orders/__tests__/repository.test.ts`
- Create: `src/app/api/case-orders/route.ts`
- Create: `src/components/orders/CaseOrderModal.tsx`
- Create: `src/components/orders/__tests__/CaseOrderModal.test.tsx`

**Interfaces:**
- Consumes: `CaseOrderInput`, `CaseOrderItemInput` from `@/types/order`、`ItemRowInput`, `ItemRow` from `@/components/orders/ItemRowInput`
- Produces: `createCaseOrder(facilityId: string, input: CaseOrderInput): Promise<CaseOrder>`、POST `/api/case-orders`、`<CaseOrderModal facilityId isOpen onClose onSuccess />`

- [ ] **Step 1: Repositoryのテストを書く（RED）**

```typescript
// src/lib/case-orders/__tests__/repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createCaseOrder } from '@/lib/case-orders/repository'

describe('createCaseOrder', () => {
  const mockOrder = {
    id: 'co-1',
    facility_id: 'f-1',
    case_datetime: '2026-06-24T10:00:00Z',
    procedure_name: 'TAVI',
    patient_id: 'P001',
    patient_initials: 'T.S.',
    gender: 'male',
    doctor_name: '田中医師',
    status: 'draft',
    created_at: '2026-06-24T00:00:00Z',
    updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', case_order_id: 'co-1', jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'case_orders') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }),
            })),
          })),
        }
      }
      if (table === 'case_order_items') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
          })),
        }
      }
    })
  })

  it('ヘッダーと明細を作成してCaseOrderを返す', async () => {
    const result = await createCaseOrder('f-1', {
      caseDatetime: '2026-06-24T10:00:00Z',
      procedureName: 'TAVI',
      patientId: 'P001',
      patientInitials: 'T.S.',
      gender: 'male',
      doctorName: '田中医師',
      items: [{ jan: '4901234567890', lot: 'L001', ubd: '2027-01', quantity: 2 }],
    })

    expect(result.id).toBe('co-1')
    expect(result.procedureName).toBe('TAVI')
    expect(result.gender).toBe('male')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].jan).toBe('4901234567890')
    expect(result.items[0].quantity).toBe(2)
  })

  it('Supabaseエラー時に例外を投げる', async () => {
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn(() => ({
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: null, error: { message: 'DB error' } }),
        })),
      })),
    }))

    await expect(
      createCaseOrder('f-1', {
        caseDatetime: '2026-06-24T10:00:00Z',
        procedureName: 'TAVI',
        patientId: 'P001',
        patientInitials: 'T.S.',
        gender: 'male',
        doctorName: '田中医師',
        items: [],
      })
    ).rejects.toThrow('DB error')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/lib/case-orders/__tests__/repository.test.ts
```

Expected: FAIL

- [ ] **Step 3: Repositoryを実装する**

```typescript
// src/lib/case-orders/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { CaseOrder, CaseOrderInput, CaseOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): CaseOrderItem {
  return {
    id: row.id as string,
    caseOrderId: row.case_order_id as string,
    jan: row.jan as string,
    lot: row.lot as string | undefined,
    ubd: row.ubd as string | undefined,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createCaseOrder(facilityId: string, input: CaseOrderInput): Promise<CaseOrder> {
  const { data: order, error: orderError } = await supabase
    .from('case_orders')
    .insert({
      facility_id: facilityId,
      case_datetime: input.caseDatetime,
      procedure_name: input.procedureName,
      patient_id: input.patientId,
      patient_initials: input.patientInitials,
      gender: input.gender,
      doctor_name: input.doctorName,
    })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const itemRows = input.items.map(item => ({
    case_order_id: (order as Record<string, unknown>).id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('case_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  const o = order as Record<string, unknown>
  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    caseDatetime: o.case_datetime as string,
    procedureName: o.procedure_name as string,
    patientId: o.patient_id as string,
    patientInitials: o.patient_initials as string,
    gender: o.gender as 'male' | 'female' | 'other',
    doctorName: o.doctor_name as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
```

- [ ] **Step 4: Repositoryテストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/lib/case-orders/__tests__/repository.test.ts
```

Expected: PASS（2件）

- [ ] **Step 5: API routeを作成する**

```typescript
// src/app/api/case-orders/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createCaseOrder } from '@/lib/case-orders/repository'
import type { CaseOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<CaseOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }

  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.caseDatetime) return NextResponse.json({ error: '症例日時は必須です' }, { status: 400 })
  if (!body.procedureName?.trim()) return NextResponse.json({ error: '手技名は必須です' }, { status: 400 })
  if (!body.patientId?.trim()) return NextResponse.json({ error: '患者IDは必須です' }, { status: 400 })
  if (!body.patientInitials?.trim()) return NextResponse.json({ error: '患者イニシャルは必須です' }, { status: 400 })
  if (!body.gender) return NextResponse.json({ error: '性別は必須です' }, { status: 400 })
  if (!body.doctorName?.trim()) return NextResponse.json({ error: '担当医師名は必須です' }, { status: 400 })

  const input: CaseOrderInput = {
    caseDatetime: body.caseDatetime,
    procedureName: body.procedureName,
    patientId: body.patientId,
    patientInitials: body.patientInitials,
    gender: body.gender,
    doctorName: body.doctorName,
    items: body.items ?? [],
  }

  try {
    const order = await createCaseOrder(body.facilityId, input)
    return NextResponse.json({ order }, { status: 201 })
  } catch (error) {
    throw error
  }
}
```

- [ ] **Step 6: CaseOrderModalのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/CaseOrderModal.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CaseOrderModal } from '../CaseOrderModal'

describe('CaseOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'co-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('症例発注')).not.toBeInTheDocument()
  })

  it('isOpen=trueのときモーダルが表示される', () => {
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByLabelText(/症例日時/)).toBeInTheDocument()
    expect(screen.getByLabelText(/手技名/)).toBeInTheDocument()
    expect(screen.getByLabelText(/患者ID/)).toBeInTheDocument()
    expect(screen.getByLabelText(/患者イニシャル/)).toBeInTheDocument()
    expect(screen.getByLabelText(/性別/)).toBeInTheDocument()
    expect(screen.getByLabelText(/担当医師/)).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/case-ordersが呼ばれる', async () => {
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={onClose} onSuccess={onSuccess} />)

    await userEvent.type(screen.getByLabelText(/症例日時/), '2026-06-24T10:00')
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/患者ID/), 'P001')
    await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'T.S.')
    await userEvent.type(screen.getByLabelText(/担当医師/), '田中医師')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))

    expect(fetch).toHaveBeenCalledWith('/api/case-orders', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.facilityId).toBe('f-1')
    expect(body.procedureName).toBe('TAVI')
    expect(onSuccess).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it('APIエラー時にエラーメッセージが表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: '送信に失敗しました' }),
    })
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument()
  })
})
```

- [ ] **Step 7: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/CaseOrderModal.test.tsx
```

Expected: FAIL

- [ ] **Step 8: CaseOrderModalを実装する**

```typescript
// src/components/orders/CaseOrderModal.tsx
'use client'

import { useState } from 'react'
import { ItemRowInput, type ItemRow } from './ItemRowInput'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function CaseOrderModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [caseDatetime, setCaseDatetime] = useState('')
  const [procedureName, setProcedureName] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientInitials, setPatientInitials] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male')
  const [doctorName, setDoctorName] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/case-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          caseDatetime,
          procedureName,
          patientId,
          patientInitials,
          gender,
          doctorName,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.error || '送信に失敗しました')
      }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
  const inputClass = 'border rounded px-3 py-2 text-sm w-full'
  const inputStyle = { borderColor: '#E5E7EB' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>症例発注</h2>
          <button type="button" onClick={onClose} style={{ color: '#6B7280' }}>✕</button>
        </div>

        {error && (
          <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="caseDatetime" className={labelClass} style={labelStyle}>症例日時 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="caseDatetime" type="datetime-local" value={caseDatetime} onChange={e => setCaseDatetime(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-4">
            <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-4">
            <label htmlFor="patientId" className={labelClass} style={labelStyle}>患者ID <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="patientId" type="text" value={patientId} onChange={e => setPatientId(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-4">
            <label htmlFor="patientInitials" className={labelClass} style={labelStyle}>患者イニシャル <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="patientInitials" type="text" value={patientInitials} onChange={e => setPatientInitials(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-4">
            <label htmlFor="gender" className={labelClass} style={labelStyle}>性別 <span style={{ color: '#DC2626' }}>*</span></label>
            <select id="gender" value={gender} onChange={e => setGender(e.target.value as 'male' | 'female' | 'other')} className={inputClass} style={inputStyle}>
              <option value="male">男</option>
              <option value="female">女</option>
              <option value="other">その他</option>
            </select>
          </div>
          <div className="mb-4">
            <label htmlFor="doctorName" className={labelClass} style={labelStyle}>担当医師 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="doctorName" type="text" value={doctorName} onChange={e => setDoctorName(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>使用物品</p>
            <ItemRowInput rows={items} onChange={setItems} />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#FF5F03' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/CaseOrderModal.test.tsx
```

Expected: PASS（4件）

- [ ] **Step 10: コミット**

```bash
git add src/lib/case-orders/ src/app/api/case-orders/ src/components/orders/CaseOrderModal.tsx src/components/orders/__tests__/CaseOrderModal.test.tsx
git commit -m "feat: add case order repository, API, and modal

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 4: 消耗品カタログ + 消耗品発注（Repository + API + Modal）[PARALLEL: Wave 2]

**Files:**
- Create: `src/lib/consumables/repository.ts`
- Create: `src/lib/consumables/__tests__/repository.test.ts`
- Create: `src/lib/consumable-orders/repository.ts`
- Create: `src/lib/consumable-orders/__tests__/repository.test.ts`
- Create: `src/app/api/consumables/route.ts`
- Create: `src/app/api/consumable-orders/route.ts`
- Create: `src/components/orders/ConsumableOrderModal.tsx`
- Create: `src/components/orders/__tests__/ConsumableOrderModal.test.tsx`

**Interfaces:**
- Consumes: `Consumable`, `ConsumableInput`, `ConsumableOrderInput` from `@/types/order`
- Produces:
  - `listConsumablesByFacility(facilityId: string): Promise<Consumable[]>`
  - `createConsumable(facilityId: string, input: ConsumableInput): Promise<Consumable>`
  - `createConsumableOrder(facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder>`
  - GET/POST `/api/consumables?facilityId=`、POST `/api/consumable-orders`
  - `<ConsumableOrderModal facilityId isOpen onClose onSuccess />`

- [ ] **Step 1: 消耗品カタログRepositoryのテストを書く（RED）**

```typescript
// src/lib/consumables/__tests__/repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'

describe('consumables repository', () => {
  const mockRow = {
    id: 'c-1', facility_id: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn().mockResolvedValue({ data: [mockRow], error: null }),
        })),
      })),
      insert: vi.fn(() => ({
        select: vi.fn(() => ({
          single: vi.fn().mockResolvedValue({ data: mockRow, error: null }),
        })),
      })),
    }))
  })

  it('listConsumablesByFacilityがConsumable[]を返す', async () => {
    const result = await listConsumablesByFacility('f-1')
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual({
      id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '4900000000001', purpose: '止血',
      createdAt: '2026-06-24T00:00:00Z', updatedAt: '2026-06-24T00:00:00Z',
    })
  })

  it('createConsumableがConsumableを返す', async () => {
    const result = await createConsumable('f-1', { name: 'ガーゼ', jan: '4900000000001', purpose: '止血' })
    expect(result.id).toBe('c-1')
    expect(result.name).toBe('ガーゼ')
  })
})
```

- [ ] **Step 2: 消耗品発注Repositoryのテストを書く（RED）**

```typescript
// src/lib/consumable-orders/__tests__/repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createConsumableOrder } from '@/lib/consumable-orders/repository'

describe('createConsumableOrder', () => {
  const mockOrder = {
    id: 'coo-1', facility_id: 'f-1', status: 'draft',
    created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', consumable_order_id: 'coo-1', consumable_id: 'c-1', quantity: 3, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'consumable_orders') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }),
            })),
          })),
        }
      }
      if (table === 'consumable_order_items') {
        return {
          insert: vi.fn(() => ({
            select: vi.fn().mockResolvedValue({ data: mockItems, error: null }),
          })),
        }
      }
    })
  })

  it('ヘッダーと明細を作成してConsumableOrderを返す', async () => {
    const result = await createConsumableOrder('f-1', {
      items: [{ consumableId: 'c-1', quantity: 3 }],
    })
    expect(result.id).toBe('coo-1')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].consumableId).toBe('c-1')
    expect(result.items[0].quantity).toBe(3)
  })
})
```

- [ ] **Step 3: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/lib/consumables/__tests__/repository.test.ts src/lib/consumable-orders/__tests__/repository.test.ts
```

Expected: FAIL

- [ ] **Step 4: 消耗品カタログRepositoryを実装する**

```typescript
// src/lib/consumables/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { Consumable, ConsumableInput } from '@/types/order'

function mapConsumable(row: Record<string, unknown>): Consumable {
  return {
    id: row.id as string,
    facilityId: row.facility_id as string,
    name: row.name as string,
    jan: row.jan as string | undefined,
    purpose: row.purpose as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  }
}

export async function listConsumablesByFacility(facilityId: string): Promise<Consumable[]> {
  const { data, error } = await supabase
    .from('consumables')
    .select('*')
    .eq('facility_id', facilityId)
    .order('purpose', { ascending: true })
  if (error) throw new Error(error.message)
  return (data as Record<string, unknown>[]).map(mapConsumable)
}

export async function createConsumable(facilityId: string, input: ConsumableInput): Promise<Consumable> {
  const { data, error } = await supabase
    .from('consumables')
    .insert({ facility_id: facilityId, name: input.name, jan: input.jan ?? null, purpose: input.purpose })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return mapConsumable(data as Record<string, unknown>)
}
```

- [ ] **Step 5: 消耗品発注Repositoryを実装する**

```typescript
// src/lib/consumable-orders/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { ConsumableOrder, ConsumableOrderInput, ConsumableOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): ConsumableOrderItem {
  return {
    id: row.id as string,
    consumableOrderId: row.consumable_order_id as string,
    consumableId: row.consumable_id as string,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createConsumableOrder(facilityId: string, input: ConsumableOrderInput): Promise<ConsumableOrder> {
  const { data: order, error: orderError } = await supabase
    .from('consumable_orders')
    .insert({ facility_id: facilityId })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const o = order as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    consumable_order_id: o.id,
    consumable_id: item.consumableId,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('consumable_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
```

- [ ] **Step 6: Repositoryテストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/lib/consumables/__tests__/repository.test.ts src/lib/consumable-orders/__tests__/repository.test.ts
```

Expected: PASS（3件）

- [ ] **Step 7: API routesを作成する**

```typescript
// src/app/api/consumables/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { listConsumablesByFacility, createConsumable } from '@/lib/consumables/repository'
import type { ConsumableInput } from '@/types/order'

export async function GET(request: NextRequest) {
  const facilityId = request.nextUrl.searchParams.get('facilityId')
  if (!facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  const consumables = await listConsumablesByFacility(facilityId)
  return NextResponse.json({ consumables })
}

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.name?.trim()) return NextResponse.json({ error: '品名は必須です' }, { status: 400 })
  if (!body.purpose?.trim()) return NextResponse.json({ error: '用途は必須です' }, { status: 400 })

  const consumable = await createConsumable(body.facilityId, {
    name: body.name,
    jan: body.jan,
    purpose: body.purpose,
  })
  return NextResponse.json({ consumable }, { status: 201 })
}
```

```typescript
// src/app/api/consumable-orders/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import type { ConsumableOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<ConsumableOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.items?.length) return NextResponse.json({ error: '発注物品を1つ以上選択してください' }, { status: 400 })

  const order = await createConsumableOrder(body.facilityId, { items: body.items })
  return NextResponse.json({ order }, { status: 201 })
}
```

- [ ] **Step 8: ConsumableOrderModalのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/ConsumableOrderModal.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsumableOrderModal } from '../ConsumableOrderModal'

const mockConsumables = [
  { id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '490000001', purpose: '止血', createdAt: '', updatedAt: '' },
  { id: 'c-2', facilityId: 'f-1', name: 'シリンジ', jan: null, purpose: '注射', createdAt: '', updatedAt: '' },
]

describe('ConsumableOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/consumables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ consumables: mockConsumables }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ order: { id: 'coo-1' } }) })
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('消耗品発注')).not.toBeInTheDocument()
  })

  it('isOpen=trueのとき消耗品一覧がロードされて表示される', async () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(await screen.findByText('ガーゼ')).toBeInTheDocument()
    expect(screen.getByText('シリンジ')).toBeInTheDocument()
  })

  it('消耗品を選択して発注するとPOSTが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await screen.findByText('ガーゼ')
    await userEvent.click(screen.getAllByRole('checkbox')[0])
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalledWith('/api/consumable-orders', expect.objectContaining({ method: 'POST' }))
    expect(onSuccess).toHaveBeenCalled()
  })

  it('1件も選択せずに送信するとエラーが表示される', async () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await screen.findByText('ガーゼ')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(await screen.findByText('発注物品を1つ以上選択してください')).toBeInTheDocument()
  })
})
```

- [ ] **Step 9: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/ConsumableOrderModal.test.tsx
```

Expected: FAIL

- [ ] **Step 10: ConsumableOrderModalを実装する**

```typescript
// src/components/orders/ConsumableOrderModal.tsx
'use client'

import { useState, useEffect } from 'react'
import type { Consumable } from '@/types/order'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

type Selection = { consumableId: string; quantity: number }

export function ConsumableOrderModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [consumables, setConsumables] = useState<Consumable[]>([])
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [purposeFilter, setPurposeFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isOpen) return
    fetch(`/api/consumables?facilityId=${facilityId}`)
      .then(r => r.json())
      .then(d => setConsumables(d.consumables ?? []))
      .catch(() => setError('消耗品の取得に失敗しました'))
  }, [isOpen, facilityId])

  if (!isOpen) return null

  const purposes = Array.from(new Set(consumables.map(c => c.purpose)))
  const filtered = purposeFilter ? consumables.filter(c => c.purpose === purposeFilter) : consumables

  const toggle = (id: string) => {
    setSelections(prev => {
      if (prev[id]) { const next = { ...prev }; delete next[id]; return next }
      return { ...prev, [id]: 1 }
    })
  }

  const setQty = (id: string, qty: number) => setSelections(prev => ({ ...prev, [id]: qty }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const items: Selection[] = Object.entries(selections).map(([consumableId, quantity]) => ({ consumableId, quantity }))
    if (!items.length) { setError('発注物品を1つ以上選択してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/consumable-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId, items }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>消耗品発注</h2>
          <button type="button" onClick={onClose} style={{ color: '#6B7280' }}>✕</button>
        </div>

        {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

        <div className="mb-4">
          <label className={labelClass} style={labelStyle}>用途で絞り込み</label>
          <select value={purposeFilter} onChange={e => setPurposeFilter(e.target.value)} className="border rounded px-3 py-2 text-sm w-full" style={{ borderColor: '#E5E7EB' }}>
            <option value="">すべて</option>
            {purposes.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4 border rounded divide-y" style={{ borderColor: '#E5E7EB' }}>
            {filtered.length === 0 && <p className="px-4 py-3 text-sm" style={{ color: '#6B7280' }}>消耗品が登録されていません</p>}
            {filtered.map(c => (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3">
                <input type="checkbox" id={`c-${c.id}`} checked={!!selections[c.id]} onChange={() => toggle(c.id)} className="w-4 h-4" />
                <label htmlFor={`c-${c.id}`} className="flex-1 text-sm" style={{ color: '#111827' }}>
                  {c.name}
                  {c.jan && <span className="ml-2 text-xs" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>{c.jan}</span>}
                  <span className="ml-2 text-xs px-1 rounded" style={{ backgroundColor: '#F3F4F6', color: '#6B7280' }}>{c.purpose}</span>
                </label>
                {selections[c.id] && (
                  <input type="number" min={1} value={selections[c.id]} onChange={e => setQty(c.id, Number(e.target.value))} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#16A34A' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 11: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/ConsumableOrderModal.test.tsx
```

Expected: PASS（4件）

- [ ] **Step 12: コミット**

```bash
git add src/lib/consumables/ src/lib/consumable-orders/ src/app/api/consumables/ src/app/api/consumable-orders/ src/components/orders/ConsumableOrderModal.tsx src/components/orders/__tests__/ConsumableOrderModal.test.tsx
git commit -m "feat: add consumable catalog and consumable order feature

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 5: 短貸発注（Repository + API + Modal）[PARALLEL: Wave 2]

**Files:**
- Create: `src/lib/loan-orders/repository.ts`
- Create: `src/lib/loan-orders/__tests__/repository.test.ts`
- Create: `src/app/api/loan-orders/route.ts`
- Create: `src/components/orders/LoanOrderModal.tsx`
- Create: `src/components/orders/__tests__/LoanOrderModal.test.tsx`

**Interfaces:**
- Consumes: `LoanOrderInput`, `LoanOrderItemInput` from `@/types/order`
- Produces: `createLoanOrder(facilityId, input): Promise<LoanOrder>`、POST `/api/loan-orders`、`<LoanOrderModal facilityId isOpen onClose onSuccess />`

- [ ] **Step 1: Repositoryのテストを書く（RED）**

```typescript
// src/lib/loan-orders/__tests__/repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createLoanOrder } from '@/lib/loan-orders/repository'

describe('createLoanOrder', () => {
  const mockOrder = {
    id: 'lo-1', facility_id: 'f-1', procedure_name: 'TAVI', maker: 'メドトロニック',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', loan_order_id: 'lo-1', jan: '490001', name: 'カテーテルA', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'loan_orders') {
        return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockOrder, error: null }) })) })) }
      }
      if (table === 'loan_order_items') {
        return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
      }
    })
  })

  it('ヘッダーと明細を作成してLoanOrderを返す', async () => {
    const result = await createLoanOrder('f-1', {
      procedureName: 'TAVI',
      maker: 'メドトロニック',
      items: [{ jan: '490001', name: 'カテーテルA', quantity: 1 }],
    })
    expect(result.id).toBe('lo-1')
    expect(result.procedureName).toBe('TAVI')
    expect(result.maker).toBe('メドトロニック')
    expect(result.items[0].name).toBe('カテーテルA')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/lib/loan-orders/__tests__/repository.test.ts
```

Expected: FAIL

- [ ] **Step 3: Repositoryを実装する**

```typescript
// src/lib/loan-orders/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { LoanOrder, LoanOrderInput, LoanOrderItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): LoanOrderItem {
  return {
    id: row.id as string,
    loanOrderId: row.loan_order_id as string,
    jan: row.jan as string | undefined,
    name: row.name as string,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createLoanOrder(facilityId: string, input: LoanOrderInput): Promise<LoanOrder> {
  const { data: order, error: orderError } = await supabase
    .from('loan_orders')
    .insert({ facility_id: facilityId, procedure_name: input.procedureName, maker: input.maker })
    .select()
    .single()
  if (orderError) throw new Error(orderError.message)

  const o = order as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    loan_order_id: o.id,
    jan: item.jan ?? null,
    name: item.name,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('loan_order_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: o.id as string,
    facilityId: o.facility_id as string,
    procedureName: o.procedure_name as string,
    maker: o.maker as string,
    status: o.status as 'draft' | 'submitted',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: o.created_at as string,
    updatedAt: o.updated_at as string,
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/lib/loan-orders/__tests__/repository.test.ts
```

Expected: PASS（1件）

- [ ] **Step 5: API routeを作成する**

```typescript
// src/app/api/loan-orders/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import type { LoanOrderInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanOrderInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.procedureName?.trim()) return NextResponse.json({ error: '手技名は必須です' }, { status: 400 })
  if (!body.maker?.trim()) return NextResponse.json({ error: 'メーカー名は必須です' }, { status: 400 })

  const input: LoanOrderInput = {
    procedureName: body.procedureName,
    maker: body.maker,
    items: body.items ?? [],
  }
  const order = await createLoanOrder(body.facilityId, input)
  return NextResponse.json({ order }, { status: 201 })
}
```

- [ ] **Step 6: LoanOrderModalのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/LoanOrderModal.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoanOrderModal } from '../LoanOrderModal'

describe('LoanOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ order: { id: 'lo-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<LoanOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('短貸発注')).not.toBeInTheDocument()
  })

  it('手技名・メーカー・物品リストが表示される', () => {
    render(<LoanOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByLabelText(/手技名/)).toBeInTheDocument()
    expect(screen.getByLabelText(/メーカー/)).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/loan-ordersが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<LoanOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
    await userEvent.type(screen.getByLabelText(/メーカー/), 'メドトロニック')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalledWith('/api/loan-orders', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body)
    expect(body.procedureName).toBe('TAVI')
    expect(body.maker).toBe('メドトロニック')
    expect(onSuccess).toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/LoanOrderModal.test.tsx
```

Expected: FAIL

- [ ] **Step 8: LoanOrderModalを実装する**

```typescript
// src/components/orders/LoanOrderModal.tsx
'use client'

import { useState } from 'react'

type LoanItemRow = { jan: string; name: string; quantity: number }

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function LoanOrderModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [procedureName, setProcedureName] = useState('')
  const [maker, setMaker] = useState('')
  const [items, setItems] = useState<LoanItemRow[]>([{ jan: '', name: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const addRow = () => setItems(prev => [...prev, { jan: '', name: '', quantity: 1 }])
  const removeRow = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: keyof LoanItemRow, value: string | number) =>
    setItems(prev => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId, procedureName, maker,
          items: items.map(r => ({ jan: r.jan || undefined, name: r.name, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
  const inputClass = 'border rounded px-3 py-2 text-sm w-full'
  const inputStyle = { borderColor: '#E5E7EB' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>短貸発注</h2>
          <button type="button" onClick={onClose} style={{ color: '#6B7280' }}>✕</button>
        </div>
        {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-4">
            <label htmlFor="maker" className={labelClass} style={labelStyle}>メーカー <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="maker" type="text" value={maker} onChange={e => setMaker(e.target.value)} required className={inputClass} style={inputStyle} />
          </div>
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>発注物品</p>
            <div className="flex gap-2 mb-1 px-1">
              <span className="text-xs font-semibold w-28" style={{ color: '#6B7280' }}>JAN（任意）</span>
              <span className="text-xs font-semibold flex-1" style={{ color: '#6B7280' }}>品名</span>
              <span className="text-xs font-semibold w-16" style={{ color: '#6B7280' }}>数量</span>
            </div>
            {items.map((row, i) => (
              <div key={i} className="flex gap-2 mb-2 items-center">
                <input type="text" value={row.jan} onChange={e => updateRow(i, 'jan', e.target.value)} placeholder="JAN" className="border rounded px-2 py-1 text-sm w-28" style={{ borderColor: '#E5E7EB' }} />
                <input type="text" value={row.name} onChange={e => updateRow(i, 'name', e.target.value)} placeholder="品名" required className="border rounded px-2 py-1 text-sm flex-1" style={{ borderColor: '#E5E7EB' }} />
                <input type="number" value={row.quantity} onChange={e => updateRow(i, 'quantity', Number(e.target.value))} min={1} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
                <button type="button" onClick={() => removeRow(i)} style={{ color: '#DC2626' }} className="text-sm px-2">削除</button>
              </div>
            ))}
            <button type="button" onClick={addRow} className="text-sm px-3 py-1 rounded border" style={{ borderColor: '#072C2C', color: '#072C2C' }}>+ 行を追加</button>
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#2563EB' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/LoanOrderModal.test.tsx
```

Expected: PASS（3件）

- [ ] **Step 10: コミット**

```bash
git add src/lib/loan-orders/ src/app/api/loan-orders/ src/components/orders/LoanOrderModal.tsx src/components/orders/__tests__/LoanOrderModal.test.tsx
git commit -m "feat: add loan order repository, API, and modal

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 6: 短貸返却（Repository + API + Modal）[PARALLEL: Wave 2]

**Files:**
- Create: `src/lib/loan-returns/repository.ts`
- Create: `src/lib/loan-returns/__tests__/repository.test.ts`
- Create: `src/app/api/loan-returns/route.ts`
- Create: `src/components/orders/LoanReturnModal.tsx`
- Create: `src/components/orders/__tests__/LoanReturnModal.test.tsx`

**Interfaces:**
- Consumes: `LoanReturnInput`, `LoanReturnItemInput` from `@/types/order`、`ItemRowInput`, `ItemRow` from `@/components/orders/ItemRowInput`
- Produces: `createLoanReturn(facilityId, input): Promise<LoanReturn>`、POST `/api/loan-returns`、`<LoanReturnModal facilityId isOpen onClose onSuccess />`

- [ ] **Step 1: Repositoryのテストを書く（RED）**

```typescript
// src/lib/loan-returns/__tests__/repository.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ supabase: {} }))

import { createLoanReturn } from '@/lib/loan-returns/repository'

describe('createLoanReturn', () => {
  const mockReturn = {
    id: 'lr-1', facility_id: 'f-1', return_datetime: '2026-06-24T15:00:00Z',
    status: 'draft', created_at: '2026-06-24T00:00:00Z', updated_at: '2026-06-24T00:00:00Z',
  }
  const mockItems = [
    { id: 'i-1', loan_return_id: 'lr-1', jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1, created_at: '2026-06-24T00:00:00Z' },
  ]

  beforeEach(async () => {
    vi.resetAllMocks()
    const { supabase } = await import('@/lib/supabase/server')
    const mock = supabase as Record<string, unknown>
    mock.from = vi.fn((table: string) => {
      if (table === 'loan_returns') {
        return { insert: vi.fn(() => ({ select: vi.fn(() => ({ single: vi.fn().mockResolvedValue({ data: mockReturn, error: null }) })) })) }
      }
      if (table === 'loan_return_items') {
        return { insert: vi.fn(() => ({ select: vi.fn().mockResolvedValue({ data: mockItems, error: null }) })) }
      }
    })
  })

  it('ヘッダーと明細を作成してLoanReturnを返す', async () => {
    const result = await createLoanReturn('f-1', {
      returnDatetime: '2026-06-24T15:00:00Z',
      items: [{ jan: '490001', lot: 'L001', ubd: '2027-01', quantity: 1 }],
    })
    expect(result.id).toBe('lr-1')
    expect(result.status).toBe('draft')
    expect(result.items[0].jan).toBe('490001')
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/lib/loan-returns/__tests__/repository.test.ts
```

Expected: FAIL

- [ ] **Step 3: Repositoryを実装する**

```typescript
// src/lib/loan-returns/repository.ts
import { supabase } from '@/lib/supabase/server'
import type { LoanReturn, LoanReturnInput, LoanReturnItem } from '@/types/order'

function mapItem(row: Record<string, unknown>): LoanReturnItem {
  return {
    id: row.id as string,
    loanReturnId: row.loan_return_id as string,
    jan: row.jan as string,
    lot: row.lot as string | undefined,
    ubd: row.ubd as string | undefined,
    quantity: row.quantity as number,
    createdAt: row.created_at as string,
  }
}

export async function createLoanReturn(facilityId: string, input: LoanReturnInput): Promise<LoanReturn> {
  const { data: ret, error: retError } = await supabase
    .from('loan_returns')
    .insert({ facility_id: facilityId, return_datetime: input.returnDatetime })
    .select()
    .single()
  if (retError) throw new Error(retError.message)

  const r = ret as Record<string, unknown>
  const itemRows = input.items.map(item => ({
    loan_return_id: r.id,
    jan: item.jan,
    lot: item.lot ?? null,
    ubd: item.ubd ?? null,
    quantity: item.quantity,
  }))

  const { data: items, error: itemsError } = await supabase
    .from('loan_return_items')
    .insert(itemRows)
    .select()
  if (itemsError) throw new Error(itemsError.message)

  return {
    id: r.id as string,
    facilityId: r.facility_id as string,
    returnDatetime: r.return_datetime as string,
    status: r.status as 'draft' | 'returned',
    items: (items as Record<string, unknown>[]).map(mapItem),
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  }
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/lib/loan-returns/__tests__/repository.test.ts
```

Expected: PASS（1件）

- [ ] **Step 5: API routeを作成する**

```typescript
// src/app/api/loan-returns/route.ts
import { NextRequest, NextResponse } from 'next/server'
import { createLoanReturn } from '@/lib/loan-returns/repository'
import type { LoanReturnInput } from '@/types/order'

export async function POST(request: NextRequest) {
  let body: { facilityId?: string } & Partial<LoanReturnInput>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'リクエストが不正です' }, { status: 400 })
  }
  if (!body.facilityId) return NextResponse.json({ error: '施設IDは必須です' }, { status: 400 })
  if (!body.returnDatetime) return NextResponse.json({ error: '返却日時は必須です' }, { status: 400 })

  const input: LoanReturnInput = {
    returnDatetime: body.returnDatetime,
    items: body.items ?? [],
  }
  const loanReturn = await createLoanReturn(body.facilityId, input)
  return NextResponse.json({ loanReturn }, { status: 201 })
}
```

- [ ] **Step 6: LoanReturnModalのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/LoanReturnModal.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LoanReturnModal } from '../LoanReturnModal'

describe('LoanReturnModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ loanReturn: { id: 'lr-1' } }),
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<LoanReturnModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('短貸返却')).not.toBeInTheDocument()
  })

  it('返却日時とJAN/LOT/UBD入力欄が表示される', () => {
    render(<LoanReturnModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.getByRole('heading', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByLabelText(/返却日時/)).toBeInTheDocument()
    expect(screen.getByPlaceholderText('JAN')).toBeInTheDocument()
  })

  it('フォーム送信でPOST /api/loan-returnsが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<LoanReturnModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await userEvent.type(screen.getByLabelText(/返却日時/), '2026-06-24T15:00')
    await userEvent.click(screen.getByRole('button', { name: '返却する' }))
    expect(fetch).toHaveBeenCalledWith('/api/loan-returns', expect.objectContaining({ method: 'POST' }))
    expect(onSuccess).toHaveBeenCalled()
  })
})
```

- [ ] **Step 7: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/LoanReturnModal.test.tsx
```

Expected: FAIL

- [ ] **Step 8: LoanReturnModalを実装する**

```typescript
// src/components/orders/LoanReturnModal.tsx
'use client'

import { useState } from 'react'
import { ItemRowInput, type ItemRow } from './ItemRowInput'

type Props = {
  facilityId: string
  isOpen: boolean
  onClose: () => void
  onSuccess: () => void
}

export function LoanReturnModal({ facilityId, isOpen, onClose, onSuccess }: Props) {
  const [returnDatetime, setReturnDatetime] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!isOpen) return null

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId,
          returnDatetime,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      onSuccess()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ backgroundColor: 'rgba(0,0,0,0.5)' }}>
      <div className="bg-white rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold" role="heading" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}>短貸返却</h2>
          <button type="button" onClick={onClose} style={{ color: '#6B7280' }}>✕</button>
        </div>
        {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label htmlFor="returnDatetime" className={labelClass} style={labelStyle}>返却日時 <span style={{ color: '#DC2626' }}>*</span></label>
            <input id="returnDatetime" type="datetime-local" value={returnDatetime} onChange={e => setReturnDatetime(e.target.value)} required className="border rounded px-3 py-2 text-sm w-full" style={{ borderColor: '#E5E7EB' }} />
          </div>
          <div className="mb-6">
            <p className={labelClass} style={labelStyle}>返却物品</p>
            <ItemRowInput rows={items} onChange={setItems} />
          </div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded border" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>キャンセル</button>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white" style={{ backgroundColor: '#4B5563' }}>
              {submitting ? '送信中...' : '返却する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 9: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/LoanReturnModal.test.tsx
```

Expected: PASS（3件）

- [ ] **Step 10: コミット**

```bash
git add src/lib/loan-returns/ src/app/api/loan-returns/ src/components/orders/LoanReturnModal.tsx src/components/orders/__tests__/LoanReturnModal.test.tsx
git commit -m "feat: add loan return repository, API, and modal

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 7: OrderButtons + 施設詳細ページ統合 [Wave 3]

**Files:**
- Create: `src/components/orders/OrderButtons.tsx`
- Create: `src/components/orders/__tests__/OrderButtons.test.tsx`
- Modify: `src/app/facilities/[id]/page.tsx`

**Interfaces:**
- Consumes: `CaseOrderModal`, `ConsumableOrderModal`, `LoanOrderModal`, `LoanReturnModal` from `@/components/orders/*`
- Produces: `<OrderButtons facilityId />` — 5ボタン群と各モーダルの制御を内包

- [ ] **Step 1: OrderButtonsのテストを書く（RED）**

```typescript
// src/components/orders/__tests__/OrderButtons.test.tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrderButtons } from '../OrderButtons'

vi.mock('../CaseOrderModal', () => ({
  CaseOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>症例発注モーダル</div> : null,
}))
vi.mock('../ConsumableOrderModal', () => ({
  ConsumableOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>消耗品発注モーダル</div> : null,
}))
vi.mock('../LoanOrderModal', () => ({
  LoanOrderModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>短貸発注モーダル</div> : null,
}))
vi.mock('../LoanReturnModal', () => ({
  LoanReturnModal: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div>短貸返却モーダル</div> : null,
}))

describe('OrderButtons', () => {
  it('5つのボタンが表示される', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('button', { name: '症例発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '消耗品発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '短貸発注' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '短貸返却' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeInTheDocument()
  })

  it('症例発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '症例発注' }))
    expect(screen.getByText('症例発注モーダル')).toBeInTheDocument()
  })

  it('消耗品発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '消耗品発注' }))
    expect(screen.getByText('消耗品発注モーダル')).toBeInTheDocument()
  })

  it('短貸発注ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '短貸発注' }))
    expect(screen.getByText('短貸発注モーダル')).toBeInTheDocument()
  })

  it('短貸返却ボタンクリックでモーダルが開く', async () => {
    render(<OrderButtons facilityId="f-1" />)
    await userEvent.click(screen.getByRole('button', { name: '短貸返却' }))
    expect(screen.getByText('短貸返却モーダル')).toBeInTheDocument()
  })

  it('長貸し処理ボタンはdisabledである', () => {
    render(<OrderButtons facilityId="f-1" />)
    expect(screen.getByRole('button', { name: '長貸し処理' })).toBeDisabled()
  })
})
```

- [ ] **Step 2: テストが失敗することを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/OrderButtons.test.tsx
```

Expected: FAIL

- [ ] **Step 3: OrderButtonsを実装する**

```typescript
// src/components/orders/OrderButtons.tsx
'use client'

import { useState } from 'react'
import { CaseOrderModal } from './CaseOrderModal'
import { ConsumableOrderModal } from './ConsumableOrderModal'
import { LoanOrderModal } from './LoanOrderModal'
import { LoanReturnModal } from './LoanReturnModal'

type Modal = 'case' | 'consumable' | 'loan' | 'loanReturn' | null

type Props = {
  facilityId: string
}

export function OrderButtons({ facilityId }: Props) {
  const [openModal, setOpenModal] = useState<Modal>(null)

  const btnBase = 'px-4 py-2 text-sm font-semibold rounded text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed'

  return (
    <>
      <div className="flex flex-wrap gap-3 mb-8">
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#FF5F03' }}
          onClick={() => setOpenModal('case')}
        >
          症例発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#16A34A' }}
          onClick={() => setOpenModal('consumable')}
        >
          消耗品発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#2563EB' }}
          onClick={() => setOpenModal('loan')}
        >
          短貸発注
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#4B5563' }}
          onClick={() => setOpenModal('loanReturn')}
        >
          短貸返却
        </button>
        <button
          type="button"
          className={btnBase}
          style={{ backgroundColor: '#9CA3AF' }}
          disabled
        >
          長貸し処理
        </button>
      </div>

      <CaseOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'case'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <ConsumableOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'consumable'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <LoanOrderModal
        facilityId={facilityId}
        isOpen={openModal === 'loan'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
      <LoanReturnModal
        facilityId={facilityId}
        isOpen={openModal === 'loanReturn'}
        onClose={() => setOpenModal(null)}
        onSuccess={() => setOpenModal(null)}
      />
    </>
  )
}
```

- [ ] **Step 4: テストが通ることを確認する**

```bash
npm test -- --reporter=verbose src/components/orders/__tests__/OrderButtons.test.tsx
```

Expected: PASS（6件）

- [ ] **Step 5: 施設詳細ページにOrderButtonsを追加する**

`src/app/facilities/[id]/page.tsx` の既存の `<div className="mb-8 border-b pb-4"...>` の直後（テーブルの前）に `<OrderButtons facilityId={id} />` を追加する。ファイル全体を以下のように置き換える：

```typescript
// src/app/facilities/[id]/page.tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { Facility } from '@/types/facility'
import { OrderButtons } from '@/components/orders/OrderButtons'

export default function FacilityDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [facility, setFacility] = useState<Facility | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`/api/facilities/${id}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() })
      .then((d) => { if (!cancelled) setFacility(d.facility) })
      .catch(() => { if (!cancelled) setError('施設の取得に失敗しました') })
    return () => { cancelled = true }
  }, [id])

  if (error) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <div className="flex items-center gap-3 rounded px-4 py-3 text-sm font-medium text-white" style={{ backgroundColor: '#DC2626', borderRadius: '2px' }}>
          <span>⚠</span>
          <span>{error}</span>
        </div>
        <Link href="/facilities" className="mt-4 inline-block text-sm hover:underline" style={{ color: '#072C2C' }}>
          ← 施設一覧に戻る
        </Link>
      </div>
    )
  }

  if (!facility) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-10">
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href="/facilities" className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Facility Detail
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          {facility.name}
        </h1>
      </div>

      <OrderButtons facilityId={id} />

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <table className="min-w-full">
          <tbody>
            <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                施設名
              </th>
              <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>
                {facility.name}
              </td>
            </tr>
            <tr style={{ borderBottom: '1px solid #E5E7EB' }}>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                登録日
              </th>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(facility.createdAt).toLocaleDateString('ja-JP')}
              </td>
            </tr>
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold uppercase tracking-widest w-40" style={{ color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif', backgroundColor: '#F9FAFB' }}>
                更新日
              </th>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(facility.updatedAt).toLocaleDateString('ja-JP')}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: 全テストが通ることを確認する**

```bash
npm test
```

Expected: 全テスト PASS、0件の失敗

- [ ] **Step 7: Lintが通ることを確認する**

```bash
npm run lint
```

Expected: エラーなし

- [ ] **Step 8: コミット**

```bash
git add src/components/orders/OrderButtons.tsx src/components/orders/__tests__/OrderButtons.test.tsx src/app/facilities/
git commit -m "feat: add OrderButtons and integrate into facility detail page

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
