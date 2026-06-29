# 発注系ページ実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 施設詳細の各発注ボタンを、モーダルではなく一覧＋新規作成ページへのナビゲーションに変更する。

**Architecture:** 施設詳細 → 一覧ページ（`/facilities/[id]/case-orders` 等）→ 新規作成ページ（`/new`）。API・DB・RLS は変更なし。既存モーダルのフォームロジックをページコンポーネントへ移植。

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind CSS, 既存 API Route

## Global Constraints

- `use client` ディレクティブは client コンポーネントのみに付与
- params は `use(params)` で unwrap（React 19 スタイル）
- デザイントークン: `#072C2C`（メイン）/ `#FF5F03`（アクセント）/ `#6B7280`（グレー）/ `#E5E7EB`（ボーダー）
- フォント: `var(--font-oswald)` / `var(--font-ubuntu-mono)`
- 既存モーダルコンポーネントは削除しない
- テストはスコープ外（既存 API テストで担保済み）

---

## ファイル構成

**変更ファイル:**
- `src/components/orders/OrderButtons.tsx` — モーダルトリガー → Link へ変更

**新規ファイル:**
- `src/app/facilities/[id]/case-orders/page.tsx` — 症例発注 一覧
- `src/app/facilities/[id]/case-orders/new/page.tsx` — 症例発注 新規作成
- `src/app/facilities/[id]/consumable-orders/page.tsx` — 消耗品発注 一覧
- `src/app/facilities/[id]/consumable-orders/new/page.tsx` — 消耗品発注 新規作成
- `src/app/facilities/[id]/loan-orders/page.tsx` — 短貸発注 一覧
- `src/app/facilities/[id]/loan-orders/new/page.tsx` — 短貸発注 新規作成
- `src/app/facilities/[id]/loan-returns/page.tsx` — 短貸返却 一覧
- `src/app/facilities/[id]/loan-returns/new/page.tsx` — 短貸返却 新規作成

---

## Task 1: OrderButtons をリンクに変更

**Files:**
- Modify: `src/components/orders/OrderButtons.tsx`

**Interfaces:**
- Consumes: `facilityId: string`（変更なし）
- Produces: 各リンクが `/facilities/{facilityId}/case-orders` 等へ遷移

- [ ] **Step 1: OrderButtons.tsx を以下のコードに全置換する**

```tsx
'use client'

import Link from 'next/link'

type Props = {
  facilityId: string
}

export function OrderButtons({ facilityId }: Props) {
  const base = `/facilities/${facilityId}`
  const btnBase = 'px-4 py-2 text-sm font-semibold rounded text-white transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-block'

  return (
    <div className="flex flex-wrap gap-3 mb-8">
      <Link href={`${base}/case-orders`} className={btnBase} style={{ backgroundColor: '#FF5F03' }}>
        症例発注
      </Link>
      <Link href={`${base}/consumable-orders`} className={btnBase} style={{ backgroundColor: '#16A34A' }}>
        消耗品発注
      </Link>
      <Link href={`${base}/loan-orders`} className={btnBase} style={{ backgroundColor: '#2563EB' }}>
        短貸発注
      </Link>
      <Link href={`${base}/loan-returns`} className={btnBase} style={{ backgroundColor: '#4B5563' }}>
        短貸返却
      </Link>
      <button
        type="button"
        className={btnBase}
        style={{ backgroundColor: '#9CA3AF', cursor: 'not-allowed', opacity: 0.5 }}
        disabled
      >
        長貸し処理
      </button>
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

開発サーバーが起動している状態で `/facilities/[任意のid]` を開き、4つのボタンが正しいURLへリンクしていることを確認する（長貸し処理は disabled のまま）。

- [ ] **Step 3: コミット**

```bash
git add src/components/orders/OrderButtons.tsx
git commit -m "feat: OrderButtonsをモーダルからLinkナビゲーションに変更"
```

---

## Task 2: 症例発注 一覧ページ

**Files:**
- Create: `src/app/facilities/[id]/case-orders/page.tsx`

**Interfaces:**
- Consumes: `GET /api/case-orders?facility_id={id}` → `{ orders: CaseOrder[] }`
- Produces: 一覧表示 + `/facilities/{id}/case-orders/new` へのリンク

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/case-orders/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { CaseOrder } from '@/types/order'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
}

export default function CaseOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [orders, setOrders] = useState<CaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/case-orders?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => setOrders(d.orders ?? []))
      .catch(() => setError('一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

  const labelClass = 'text-xs font-semibold uppercase tracking-widest'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="flex items-end justify-between mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className={`${labelClass} mb-1`} style={{ ...labelStyle, color: '#FF5F03' }}>Case Orders</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            症例発注
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/case-orders/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#FF5F03' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>発注履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>症例日時</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>手技名</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {order.caseDatetime ? new Date(order.caseDatetime).toLocaleString('ja-JP') : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>{order.procedureName}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[order.status] ?? order.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(order.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

`/facilities/[id]/case-orders` へアクセスし、一覧テーブルが表示されること・「新規作成」ボタンが機能することを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/case-orders/page.tsx
git commit -m "feat: 症例発注一覧ページを追加"
```

---

## Task 3: 症例発注 新規作成ページ

**Files:**
- Create: `src/app/facilities/[id]/case-orders/new/page.tsx`

**Interfaces:**
- Consumes: `POST /api/case-orders`
- Produces: 送信成功後 `/facilities/{id}/case-orders` へリダイレクト

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/case-orders/new/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ItemRowInput, type ItemRow } from '@/components/orders/ItemRowInput'

export default function NewCaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [caseDatetime, setCaseDatetime] = useState('')
  const [procedureName, setProcedureName] = useState('')
  const [patientId, setPatientId] = useState('')
  const [patientInitials, setPatientInitials] = useState('')
  const [gender, setGender] = useState<'male' | 'female' | 'other'>('male')
  const [doctorName, setDoctorName] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!procedureName.trim()) { setError('手技名を入力してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/case-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          caseDatetime,
          procedureName,
          patientId,
          patientInitials,
          gender,
          doctorName,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/case-orders`)
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
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/case-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 症例発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>New Case Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          症例発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="caseDatetime" className={labelClass} style={labelStyle}>症例日時 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="caseDatetime" type="datetime-local" value={caseDatetime} onChange={e => setCaseDatetime(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="patientId" className={labelClass} style={labelStyle}>患者ID <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="patientId" type="text" value={patientId} onChange={e => setPatientId(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="patientInitials" className={labelClass} style={labelStyle}>患者イニシャル <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="patientInitials" type="text" value={patientInitials} onChange={e => setPatientInitials(e.target.value)} className={inputClass} style={inputStyle} />
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
          <input id="doctorName" type="text" value={doctorName} onChange={e => setDoctorName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-6">
          <p className={labelClass} style={labelStyle}>使用物品</p>
          <ItemRowInput rows={items} onChange={setItems} />
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/case-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#FF5F03' }}>
            {submitting ? '送信中...' : '発注する'}
          </button>
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

フォームを入力して送信し、一覧ページへリダイレクトされること・一覧に新しい発注が表示されることを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/case-orders/new/page.tsx
git commit -m "feat: 症例発注新規作成ページを追加"
```

---

## Task 4: 消耗品発注 一覧ページ

**Files:**
- Create: `src/app/facilities/[id]/consumable-orders/page.tsx`

**Interfaces:**
- Consumes: `GET /api/consumable-orders?facility_id={id}` → `{ orders: ConsumableOrder[] }`
- Produces: 一覧表示 + `/facilities/{id}/consumable-orders/new` へのリンク

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/consumable-orders/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { ConsumableOrder } from '@/types/order'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
}

export default function ConsumableOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [orders, setOrders] = useState<ConsumableOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/consumable-orders?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => setOrders(d.orders ?? []))
      .catch(() => setError('一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="flex items-end justify-between mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#16A34A' }}>Consumable Orders</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            消耗品発注
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/consumable-orders/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#16A34A' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>発注履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[order.status] ?? order.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(order.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

`/facilities/[id]/consumable-orders` へアクセスし一覧が表示されることを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/consumable-orders/page.tsx
git commit -m "feat: 消耗品発注一覧ページを追加"
```

---

## Task 5: 消耗品発注 新規作成ページ

**Files:**
- Create: `src/app/facilities/[id]/consumable-orders/new/page.tsx`

**Interfaces:**
- Consumes: `GET /api/consumables?facilityId={id}` → `{ consumables: Consumable[] }`、`POST /api/consumable-orders`
- Produces: 送信成功後 `/facilities/{id}/consumable-orders` へリダイレクト

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/consumable-orders/new/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { Consumable } from '@/types/order'

export default function NewConsumableOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [consumables, setConsumables] = useState<Consumable[]>([])
  const [selections, setSelections] = useState<Record<string, number>>({})
  const [purposeFilter, setPurposeFilter] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/consumables?facilityId=${id}`)
      .then(r => r.json())
      .then(d => setConsumables(d.consumables ?? []))
      .catch(() => setError('消耗品の取得に失敗しました'))
  }, [id])

  const purposes = Array.from(new Set(consumables.map(c => c.purpose)))
  const filtered = purposeFilter ? consumables.filter(c => c.purpose === purposeFilter) : consumables

  const toggle = (consumableId: string) => {
    setSelections(prev => {
      if (prev[consumableId]) { const next = { ...prev }; delete next[consumableId]; return next }
      return { ...prev, [consumableId]: 1 }
    })
  }

  const setQty = (consumableId: string, qty: number) => setSelections(prev => ({ ...prev, [consumableId]: qty }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const items = Object.entries(selections).map(([consumableId, quantity]) => ({ consumableId, quantity }))
    if (!items.length) { setError('発注物品を1つ以上選択してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/consumable-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId: id, items }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/consumable-orders`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/consumable-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 消耗品発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#16A34A', fontFamily: 'var(--font-oswald), sans-serif' }}>New Consumable Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          消耗品発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <div className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
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
                  <input type="number" min={1} value={selections[c.id]} onChange={e => setQty(c.id, Number(e.target.value) || 1)} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
                )}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <Link href={`/facilities/${id}/consumable-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
              キャンセル
            </Link>
            <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#16A34A' }}>
              {submitting ? '送信中...' : '発注する'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

消耗品を選択して送信し、一覧へリダイレクトされること・一覧に反映されることを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/consumable-orders/new/page.tsx
git commit -m "feat: 消耗品発注新規作成ページを追加"
```

---

## Task 6: 短貸発注 一覧ページ

**Files:**
- Create: `src/app/facilities/[id]/loan-orders/page.tsx`

**Interfaces:**
- Consumes: `GET /api/loan-orders?facility_id={id}` → `{ orders: LoanOrder[] }`
- Produces: 一覧表示 + `/facilities/{id}/loan-orders/new` へのリンク

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/loan-orders/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { LoanOrder } from '@/types/order'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  submitted: '提出済',
}

export default function LoanOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [orders, setOrders] = useState<LoanOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/loan-orders?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => setOrders(d.orders ?? []))
      .catch(() => setError('一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="flex items-end justify-between mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#2563EB' }}>Loan Orders</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            短貸発注
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/loan-orders/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#2563EB' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : orders.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>発注履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>手技名</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>メーカー</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(order => (
                <tr key={order.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>{order.procedureName}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{order.maker}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[order.status] ?? order.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(order.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

`/facilities/[id]/loan-orders` へアクセスし一覧が表示されることを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/loan-orders/page.tsx
git commit -m "feat: 短貸発注一覧ページを追加"
```

---

## Task 7: 短貸発注 新規作成ページ

**Files:**
- Create: `src/app/facilities/[id]/loan-orders/new/page.tsx`

**Interfaces:**
- Consumes: `POST /api/loan-orders`
- Produces: 送信成功後 `/facilities/{id}/loan-orders` へリダイレクト

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/loan-orders/new/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

type LoanItemRow = { jan: string; name: string; quantity: number }

export default function NewLoanOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [procedureName, setProcedureName] = useState('')
  const [maker, setMaker] = useState('')
  const [items, setItems] = useState<LoanItemRow[]>([{ jan: '', name: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const addRow = () => setItems(prev => [...prev, { jan: '', name: '', quantity: 1 }])
  const removeRow = (i: number) => setItems(prev => prev.filter((_, idx) => idx !== i))
  const updateRow = (i: number, field: keyof LoanItemRow, value: string | number) =>
    setItems(prev => prev.map((r, idx) => (idx === i ? { ...r, [field]: value } : r)))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!procedureName.trim()) { setError('手技名を入力してください'); return }
    if (!maker.trim()) { setError('メーカーを入力してください'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          procedureName,
          maker,
          items: items.map(r => ({ jan: r.jan || undefined, name: r.name, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/loan-orders`)
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
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/loan-orders`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 短貸発注一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#2563EB', fontFamily: 'var(--font-oswald), sans-serif' }}>New Loan Order</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          短貸発注
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="procedureName" className={labelClass} style={labelStyle}>手技名 <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="procedureName" type="text" value={procedureName} onChange={e => setProcedureName(e.target.value)} className={inputClass} style={inputStyle} />
        </div>
        <div className="mb-4">
          <label htmlFor="maker" className={labelClass} style={labelStyle}>メーカー <span style={{ color: '#DC2626' }}>*</span></label>
          <input id="maker" type="text" value={maker} onChange={e => setMaker(e.target.value)} className={inputClass} style={inputStyle} />
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
              <input type="text" value={row.name} onChange={e => updateRow(i, 'name', e.target.value)} placeholder="品名" className="border rounded px-2 py-1 text-sm flex-1" style={{ borderColor: '#E5E7EB' }} />
              <input type="number" value={row.quantity} onChange={e => updateRow(i, 'quantity', Number(e.target.value) || 0)} min={1} className="border rounded px-2 py-1 text-sm w-16" style={{ borderColor: '#E5E7EB' }} />
              <button type="button" onClick={() => removeRow(i)} className="text-sm px-2" style={{ color: '#DC2626' }}>削除</button>
            </div>
          ))}
          <button type="button" onClick={addRow} className="text-sm px-3 py-1 rounded border" style={{ borderColor: '#072C2C', color: '#072C2C' }}>+ 行を追加</button>
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/loan-orders`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#2563EB' }}>
            {submitting ? '送信中...' : '発注する'}
          </button>
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

フォームを入力して送信し、一覧ページへリダイレクトされること・一覧に反映されることを確認する。

- [ ] **Step 3: コミット**

```bash
git add src/app/facilities/\[id\]/loan-orders/new/page.tsx
git commit -m "feat: 短貸発注新規作成ページを追加"
```

---

## Task 8: 短貸返却 一覧ページ

**Files:**
- Create: `src/app/facilities/[id]/loan-returns/page.tsx`

**Interfaces:**
- Consumes: `GET /api/loan-returns?facility_id={id}` → `{ returns: LoanReturn[] }`
- Produces: 一覧表示 + `/facilities/{id}/loan-returns/new` へのリンク

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/loan-returns/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useEffect, useState } from 'react'
import Link from 'next/link'
import type { LoanReturn } from '@/types/order'

const STATUS_LABEL: Record<string, string> = {
  draft: '下書き',
  returned: '返却済',
}

export default function LoanReturnsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [returns, setReturns] = useState<LoanReturn[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`/api/loan-returns?facility_id=${id}`)
      .then(r => { if (!r.ok) throw new Error(); return r.json() })
      .then(d => setReturns(d.returns ?? []))
      .catch(() => setError('一覧の取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="flex items-end justify-between mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ ...labelStyle, color: '#4B5563' }}>Loan Returns</p>
          <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
            短貸返却
          </h1>
        </div>
        <Link
          href={`/facilities/${id}/loan-returns/new`}
          className="px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90"
          style={{ backgroundColor: '#4B5563' }}
        >
          新規作成
        </Link>
      </div>

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>
      )}

      {loading ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      ) : returns.length === 0 ? (
        <p className="text-sm" style={{ color: '#6B7280' }}>返却履歴がありません。</p>
      ) : (
        <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>返却日時</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ステータス</th>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>作成日</th>
              </tr>
            </thead>
            <tbody>
              {returns.map(ret => (
                <tr key={ret.id} style={{ borderBottom: '1px solid #E5E7EB' }}>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {ret.returnDatetime ? new Date(ret.returnDatetime).toLocaleString('ja-JP') : '-'}
                  </td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{STATUS_LABEL[ret.status] ?? ret.status}</td>
                  <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                    {new Date(ret.createdAt).toLocaleDateString('ja-JP')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: loan-returns API のレスポンスキー確認**

```bash
grep -n "returns\|orders" /Users/masanori/medical-inventory-vkumai/src/app/api/loan-returns/route.ts | head -20
```

レスポンスが `{ returns: [...] }` でなく `{ loanReturns: [...] }` の場合は Step 1 のコードの `d.returns` を適切なキーに変更する。

- [ ] **Step 3: 動作確認**

`/facilities/[id]/loan-returns` へアクセスし一覧が表示されることを確認する。

- [ ] **Step 4: コミット**

```bash
git add src/app/facilities/\[id\]/loan-returns/page.tsx
git commit -m "feat: 短貸返却一覧ページを追加"
```

---

## Task 9: 短貸返却 新規作成ページ

**Files:**
- Create: `src/app/facilities/[id]/loan-returns/new/page.tsx`

**Interfaces:**
- Consumes: `POST /api/loan-returns`
- Produces: 送信成功後 `/facilities/{id}/loan-returns` へリダイレクト

- [ ] **Step 1: ファイルを作成する**

`src/app/facilities/[id]/loan-returns/new/page.tsx` を以下の内容で作成する:

```tsx
'use client'

import { use, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ItemRowInput, type ItemRow } from '@/components/orders/ItemRowInput'

export default function NewLoanReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()

  const [returnDatetime, setReturnDatetime] = useState('')
  const [items, setItems] = useState<ItemRow[]>([{ jan: '', lot: '', ubd: '', quantity: 1 }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/loan-returns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facilityId: id,
          returnDatetime,
          items: items.map(r => ({ jan: r.jan, lot: r.lot || undefined, ubd: r.ubd || undefined, quantity: r.quantity })),
        }),
      })
      if (!res.ok) { const d = await res.json(); throw new Error(d.error || '送信に失敗しました') }
      router.push(`/facilities/${id}/loan-returns`)
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  const labelClass = 'block text-xs font-semibold uppercase tracking-widest mb-1'
  const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}/loan-returns`} className="text-sm hover:underline" style={{ color: '#6B7280' }}>
          ← 短貸返却一覧に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }}>New Loan Return</p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          短貸返却
        </h1>
      </div>

      {error && <div className="mb-4 px-4 py-2 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white rounded shadow-sm p-6" style={{ border: '1px solid #E5E7EB' }}>
        <div className="mb-4">
          <label htmlFor="returnDatetime" className={labelClass} style={labelStyle}>返却日時 <span style={{ color: '#DC2626' }}>*</span></label>
          <input
            id="returnDatetime"
            type="datetime-local"
            value={returnDatetime}
            onChange={e => setReturnDatetime(e.target.value)}
            required
            className="border rounded px-3 py-2 text-sm w-full"
            style={{ borderColor: '#E5E7EB' }}
          />
        </div>
        <div className="mb-6">
          <p className={labelClass} style={labelStyle}>返却物品</p>
          <ItemRowInput rows={items} onChange={setItems} />
        </div>
        <div className="flex justify-end gap-3">
          <Link href={`/facilities/${id}/loan-returns`} className="px-4 py-2 text-sm rounded border inline-block" style={{ borderColor: '#E5E7EB', color: '#6B7280' }}>
            キャンセル
          </Link>
          <button type="submit" disabled={submitting} className="px-4 py-2 text-sm rounded text-white hover:opacity-90 disabled:opacity-50" style={{ backgroundColor: '#4B5563' }}>
            {submitting ? '送信中...' : '返却する'}
          </button>
        </div>
      </form>
    </div>
  )
}
```

- [ ] **Step 2: 動作確認**

フォームを入力して送信し、一覧ページへリダイレクトされること・一覧に反映されることを確認する。

- [ ] **Step 3: lint & test 実行**

```bash
npm run lint && npm test
```

すべてパスすることを確認する。

- [ ] **Step 4: コミット**

```bash
git add src/app/facilities/\[id\]/loan-returns/new/page.tsx
git commit -m "feat: 短貸返却新規作成ページを追加"
```
