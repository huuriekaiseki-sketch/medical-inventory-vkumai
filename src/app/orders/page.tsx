'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Facility } from '@/types/facility'
import type { OrderKind, OrderListItem } from '@/types/order'
import { OrderHistoryTable } from '@/components/orders/OrderHistoryTable'
import { OrderHistoryFilters } from '@/components/orders/OrderHistoryFilters'

const LIMIT = 50

// WHY: issue #20 Part1「タブ: すべて/症例発注/消耗品発注/短貸発注/短貸返却」= OrderKindの4種別+全体タブ1件。
const TABS: { value: OrderKind | null; label: string }[] = [
  { value: null, label: 'すべて' },
  { value: 'case_order', label: '症例発注' },
  { value: 'consumable_order', label: '消耗品発注' },
  { value: 'loan_order', label: '短貸発注' },
  { value: 'loan_return', label: '短貸返却' },
]

// WHY: URLのsearchParamsは利用者が自由に書き換えられるため、`?kind=xxx`の値を
//      無検証でOrderKind型にキャストすると、不正な値がそのまま/api/ordersへ渡り400エラーで
//      画面が壊れてしまう（レビュー指摘）。既知の4種別のみ受け入れ、それ以外は「すべて」扱いにする
const VALID_KINDS: OrderKind[] = ['case_order', 'consumable_order', 'loan_order', 'loan_return']
function parseKind(value: string | null): OrderKind | null {
  return VALID_KINDS.includes(value as OrderKind) ? (value as OrderKind) : null
}

function OrdersPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const kind = parseKind(searchParams.get('kind'))
  const dateFrom = searchParams.get('dateFrom') ?? ''
  const dateTo = searchParams.get('dateTo') ?? ''
  const keyword = searchParams.get('keyword') ?? ''
  const offset = Number(searchParams.get('offset') ?? '0')

  // WHY: /orders はグローバルナビからアクセスする横断ページで、/facilities/[id]/... のように
  // URLパスに施設IDを含まない。/api/facilities から取得した一覧から対象施設を選ぶ
  // (news/page.tsx の非admin時デフォルトと同じ考え方。/api/orders は facility_id 必須のため
  // 「全施設」相当の選択肢は用意しない)。
  // WHY: user_facilities は1ユーザーが複数施設に所属できる（docs/agents/domain.md）ため、
  //      先頭施設に固定すると2件目以降の施設に所属するスタッフが自施設の発注を確認できない
  //      （issue #20 レビュー指摘: 正しさ important）。URLの `facilityId` を優先し、
  //      未指定・不正な値のときのみ先頭施設にフォールバックする
  const urlFacilityId = searchParams.get('facilityId')
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [initialized, setInitialized] = useState(false)
  const [items, setItems] = useState<OrderListItem[]>([])
  const [ordersLoading, setOrdersLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const facilityId =
    urlFacilityId && facilities.some((f) => f.id === urlFacilityId)
      ? urlFacilityId
      : (facilities[0]?.id ?? null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/facilities')
        if (!res.ok) throw new Error()
        const data = await res.json()
        const loadedFacilities = data.facilities as Facility[]
        if (cancelled) return
        setFacilities(loadedFacilities)
        setInitialized(true)
      } catch {
        if (!cancelled) {
          setError('発注履歴の取得に失敗しました')
          setInitialized(true)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // WHY: itemsの初期値は[]のため、ローディング状態を管理しないと発注データ取得中にも
  //      「発注履歴がありません」が一瞬表示されてしまう（issue #20 レビュー指摘: 正しさ important）
  useEffect(() => {
    let cancelled = false
    async function loadOrders() {
      if (!initialized) return
      if (!facilityId) {
        setOrdersLoading(false)
        return
      }
      setOrdersLoading(true)
      try {
        const params = new URLSearchParams()
        params.set('facility_id', facilityId)
        if (kind) params.set('kind', kind)
        if (dateFrom) params.set('date_from', dateFrom)
        if (dateTo) params.set('date_to', dateTo)
        if (keyword) params.set('keyword', keyword)
        params.set('limit', String(LIMIT))
        params.set('offset', String(offset))

        const res = await fetch(`/api/orders?${params.toString()}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setItems(data.orders ?? [])
        setError(null)
      } catch {
        if (!cancelled) setError('発注履歴の取得に失敗しました')
      } finally {
        if (!cancelled) setOrdersLoading(false)
      }
    }
    loadOrders()
    return () => {
      cancelled = true
    }
  }, [initialized, facilityId, kind, dateFrom, dateTo, keyword, offset])

  // WHY: タブ・期間・キーワードのいずれかを変更したら先頭ページ(offset=0)に戻すため、
  // 新しいURLを組み立てる際は常に offset パラメータを落とす(SPEC Part2 Set E)。
  function pushParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString())
    params.delete('offset')
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value)
      else params.delete(key)
    }
    const query = params.toString()
    router.push(query ? `/orders?${query}` : '/orders')
  }

  function handleClear() {
    router.push('/orders')
  }

  // WHY: タブ・フィルタと違いページ送りはoffsetを維持したまま切り替えるため、
  //      offsetを常に落とすpushParamsとは別関数にする（issue #20 レビュー指摘:
  //      重複・過剰実装 important — ページネーションUIが欠落していた）
  function goToOffset(newOffset: number) {
    const params = new URLSearchParams(searchParams.toString())
    if (newOffset > 0) params.set('offset', String(newOffset))
    else params.delete('offset')
    const query = params.toString()
    router.push(query ? `/orders?${query}` : '/orders')
  }

  // WHY: 施設セレクタもタブ・フィルタと同様、切り替え時はoffsetを先頭に戻す
  function handleFacilityChange(newFacilityId: string) {
    pushParams({ facilityId: newFacilityId })
  }

  const hasFilter = Boolean(kind || dateFrom || dateTo || keyword)

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4 flex items-end justify-between" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}
          >
            Orders
          </p>
          <h1
            className="text-3xl font-bold"
            style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
          >
            発注履歴
          </h1>
        </div>
        {/* WHY: 1施設のみ所属のユーザーには不要な選択肢を出さない（既存テストの前提と合わせる） */}
        {facilities.length > 1 && (
          <div>
            <label htmlFor="orders-facility-select" className="sr-only">
              施設を選択
            </label>
            <select
              id="orders-facility-select"
              value={facilityId ?? ''}
              onChange={(e) => handleFacilityChange(e.target.value)}
              className="rounded border px-3 py-2 text-sm"
              style={{ borderColor: '#072C2C33', color: '#072C2C' }}
            >
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <div role="tablist" className="mb-6 flex flex-wrap gap-2">
        {TABS.map((tab) => {
          const selected = kind === tab.value
          return (
            <button
              key={tab.label}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => pushParams({ kind: tab.value })}
              className="px-4 py-2 text-sm font-semibold rounded"
              style={
                selected
                  ? { backgroundColor: '#072C2C', color: 'white' }
                  : { border: '1px solid #072C2C33', color: '#072C2C' }
              }
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      <OrderHistoryFilters
        dateFrom={dateFrom}
        dateTo={dateTo}
        keyword={keyword}
        onDateFromChange={(value) => pushParams({ dateFrom: value })}
        onDateToChange={(value) => pushParams({ dateTo: value })}
        onKeywordChange={(value) => pushParams({ keyword: value })}
        onClear={handleClear}
      />

      {error && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>
          {error}
        </div>
      )}

      {!error && ordersLoading && (
        <p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>
      )}

      {!error && !ordersLoading && items.length === 0 && (
        <p className="text-sm" style={{ color: '#6B7280' }}>
          {hasFilter ? '条件に一致する発注がありません' : '発注履歴がありません'}
        </p>
      )}

      {!error && !ordersLoading && items.length > 0 && (
        <>
          <OrderHistoryTable items={items} />
          {/* WHY: APIは総件数を返さないため、返却件数がLIMIT未満なら「次へ」を無効化する
              （返却件数=LIMITのときのみ次ページが存在しうると判定する簡易実装） */}
          <div className="mt-4 flex items-center justify-between">
            <button
              type="button"
              disabled={offset === 0}
              onClick={() => goToOffset(Math.max(0, offset - LIMIT))}
              className="px-4 py-2 text-sm rounded border disabled:opacity-40"
              style={{ borderColor: '#072C2C33', color: '#072C2C' }}
            >
              前へ
            </button>
            <button
              type="button"
              disabled={items.length < LIMIT}
              onClick={() => goToOffset(offset + LIMIT)}
              className="px-4 py-2 text-sm rounded border disabled:opacity-40"
              style={{ borderColor: '#072C2C33', color: '#072C2C' }}
            >
              次へ
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<p className="text-sm" style={{ color: '#6B7280' }}>読み込み中...</p>}>
      <OrdersPageInner />
    </Suspense>
  )
}
