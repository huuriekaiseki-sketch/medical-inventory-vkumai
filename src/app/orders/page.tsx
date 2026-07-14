'use client'

import { Suspense, useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Facility } from '@/types/facility'
import type { OrderKind, UnifiedOrder, OrdersFetchError } from '@/types/order'
import { OrderHistoryFilters } from '@/components/orders/OrderHistoryFilters'
import { OrderHistoryTable } from '@/components/orders/OrderHistoryTable'

const ALL_KINDS: OrderKind[] = ['case', 'consumable', 'loan', 'loan_return']

// WHY: /orders は施設・種別をまたいだ横断表示のため、行ごとの「詳細」リンクは
// 個別レコードの詳細ページが存在しない（既存4ページはいずれも一覧のみ、単票詳細URLが無い）。
// SPEC.mdは「既存の詳細ページへ遷移できる」を前提にしていたが実装調査の結果そのページは
// 存在しないため、次善として施設スコープの既存一覧ページへリンクする
function detailHrefFor(order: UnifiedOrder): string {
  switch (order.kind) {
    case 'case':
      return `/facilities/${order.facilityId}/case-orders`
    case 'consumable':
      return `/facilities/${order.facilityId}/consumable-orders`
    case 'loan':
      return `/facilities/${order.facilityId}/loan-orders`
    case 'loan_return':
      return `/facilities/${order.facilityId}/loan-returns`
    default:
      return `/facilities/${order.facilityId}`
  }
}

// WHY: 選択日（JST, yyyy-mm-dd）を UTC ISO文字列に変換するユーティリティ。
// date_from は選択日 00:00:00+09:00、date_to は選択日 23:59:59.999+09:00（その日を含む終端）
// をそれぞれ UTC に変換してAPIへ渡す。SPEC.mdはdate_toの境界仕様（以上/未満）を明記していないため、
// 「選択した日を含む」という直感的な解釈を採用した
function jstDateStartToUtcIso(dateStr: string): string {
  return new Date(`${dateStr}T00:00:00+09:00`).toISOString()
}
function jstDateEndToUtcIso(dateStr: string): string {
  return new Date(`${dateStr}T23:59:59.999+09:00`).toISOString()
}

// WHY: order_kinds が未指定（param === null）の場合のみ「全種別」を意味する。
// order_kinds=（空文字）はAPI層（/api/orders）の契約と同じく「0種別を明示的に選択した」
// として扱う必要がある。以前は空文字も !param で「未指定」と誤判定してALL_KINDSに
// フォールバックしており、全チェックボックス解除後にURL直リンク/リロードすると
// 無警告で全種別が表示されるバグがあった（レビューで検出）
function parseKinds(param: string | null): OrderKind[] {
  if (param === null) return ALL_KINDS
  return param.split(',').filter((v): v is OrderKind => (ALL_KINDS as string[]).includes(v))
}

type CommittedFilters = {
  dateFrom: string
  dateTo: string
  productSearch: string
  kinds: OrderKind[]
}

function buildQueryString(filters: CommittedFilters, facilityId: string): string {
  const params = new URLSearchParams()
  if (facilityId) params.set('facility_id', facilityId)
  if (filters.dateFrom) params.set('date_from', jstDateStartToUtcIso(filters.dateFrom))
  if (filters.dateTo) params.set('date_to', jstDateEndToUtcIso(filters.dateTo))
  if (filters.productSearch) params.set('product_search', filters.productSearch)
  if (filters.kinds.length < ALL_KINDS.length) params.set('order_kinds', filters.kinds.join(','))
  return params.toString()
}

// WHY: URL表示用は date_from/date_to をJST日付のまま保持し（UTC変換前のraw値）、
// order_kinds・facility_idはAPIリクエストと同じ形式にする。UTC変換済みISO文字列を
// URLに出すとユーザーには読みにくいため、URL表示とAPIリクエストのクエリを分離する
function buildDisplayQueryString(filters: CommittedFilters, facilityId: string): string {
  const params = new URLSearchParams()
  if (facilityId) params.set('facility_id', facilityId)
  if (filters.dateFrom) params.set('date_from', filters.dateFrom)
  if (filters.dateTo) params.set('date_to', filters.dateTo)
  if (filters.productSearch) params.set('product_search', filters.productSearch)
  if (filters.kinds.length < ALL_KINDS.length) params.set('order_kinds', filters.kinds.join(','))
  return params.toString()
}

function OrdersPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [facilities, setFacilities] = useState<Facility[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [facilitiesLoaded, setFacilitiesLoaded] = useState(false)
  const [selectedFacilityId, setSelectedFacilityId] = useState<string>('')

  const [draftDateFrom, setDraftDateFrom] = useState(searchParams.get('date_from') ?? '')
  const [draftDateTo, setDraftDateTo] = useState(searchParams.get('date_to') ?? '')
  const [draftProductSearch, setDraftProductSearch] = useState(searchParams.get('product_search') ?? '')

  const [committed, setCommitted] = useState<CommittedFilters>({
    dateFrom: searchParams.get('date_from') ?? '',
    dateTo: searchParams.get('date_to') ?? '',
    productSearch: searchParams.get('product_search') ?? '',
    kinds: parseKinds(searchParams.get('order_kinds')),
  })

  const [orders, setOrders] = useState<UnifiedOrder[]>([])
  const [fetchErrors, setFetchErrors] = useState<OrdersFetchError[]>([])
  const [loading, setLoading] = useState(true)
  const [apiError, setApiError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  // 初回: /api/user-facilities から isAdmin・所属施設一覧を取得し、初期選択施設を決定する。
  // WHY(issue #20 統合ゲート): /api/facilities は全施設を返す仕様のため、非adminが
  // 所属していない施設まで選択肢に出てしまい、初期選択施設が所属外で403になる不整合が
  // あった。非adminは所属施設のみを返す /api/user-facilities を使うことで解消する
  useEffect(() => {
    let cancelled = false
    async function loadFacilities() {
      try {
        const res = await fetch('/api/user-facilities')
        if (res.status === 401) {
          router.push('/login')
          return
        }
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        const loadedFacilities: Facility[] = data.facilities ?? []
        const admin: boolean = data.isAdmin ?? false
        setFacilities(loadedFacilities)
        setIsAdmin(admin)

        const urlFacilityId = searchParams.get('facility_id')
        if (admin) {
          // admin: URLのfacility_idが有効ならそれを、無ければ空（全施設）
          const isValid = urlFacilityId !== null && loadedFacilities.some((f) => f.id === urlFacilityId)
          setSelectedFacilityId(isValid ? urlFacilityId! : '')
        } else {
          const isValid = urlFacilityId !== null && loadedFacilities.some((f) => f.id === urlFacilityId)
          const resolved = isValid ? urlFacilityId! : (loadedFacilities[0]?.id ?? '')
          setSelectedFacilityId(resolved)
        }
        setFacilitiesLoaded(true)
      } catch {
        if (!cancelled) {
          setApiError('施設情報の取得に失敗しました')
          setFacilitiesLoaded(true)
        }
      }
    }
    loadFacilities()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 施設情報が確定した後、非adminはfacility_idが必須のため確定するまで待つ
  const canFetch = facilitiesLoaded && (isAdmin || selectedFacilityId !== '')
  // WHY: 非adminでどの施設にも所属していない場合、selectedFacilityIdが永遠に確定せず
  // canFetchもtrueにならないため、何もせず放置すると読み込み中スケルトンが無限に表示され続ける。
  // setLoading側で個別にハンドリングするとエフェクト内setStateのcascading renderになるため、
  // 代わりに描画用のloadingフラグをレンダー時に導出し、このケースだけ強制的にfalse扱いにする
  const noFacilityAccess = facilitiesLoaded && !isAdmin && facilities.length === 0
  const displayLoading = loading && !noFacilityAccess

  useEffect(() => {
    if (!canFetch) return
    let cancelled = false
    async function loadOrders() {
      setLoading(true)
      setApiError(null)
      try {
        const qs = buildQueryString(committed, selectedFacilityId)
        const res = await fetch(`/api/orders${qs ? `?${qs}` : ''}`)
        if (res.status === 401) {
          router.push('/login')
          return
        }
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.error ?? '発注履歴の取得に失敗しました')
        }
        const data = await res.json()
        if (cancelled) return
        setOrders(data.orders ?? [])
        setFetchErrors(data.errors ?? [])
      } catch (e) {
        if (!cancelled) {
          setApiError(e instanceof Error ? e.message : '発注履歴の取得に失敗しました')
          setOrders([])
          setFetchErrors([])
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    loadOrders()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canFetch, committed, selectedFacilityId, refreshToken])

  const syncUrl = useCallback(
    (nextCommitted: CommittedFilters, nextFacilityId: string) => {
      const qs = buildDisplayQueryString(nextCommitted, nextFacilityId)
      router.replace(`/orders${qs ? `?${qs}` : ''}`)
    },
    [router]
  )

  function handleKindsChange(kinds: OrderKind[]) {
    const next = { ...committed, kinds }
    setCommitted(next)
    syncUrl(next, selectedFacilityId)
  }

  function handleFacilityChange(facilityId: string) {
    setSelectedFacilityId(facilityId)
    syncUrl(committed, facilityId)
  }

  function handleSearchSubmit() {
    const next: CommittedFilters = {
      ...committed,
      dateFrom: draftDateFrom,
      dateTo: draftDateTo,
      productSearch: draftProductSearch,
    }
    setCommitted(next)
    syncUrl(next, selectedFacilityId)
  }

  function handleRetry() {
    setRefreshToken((t) => t + 1)
  }

  const showFacilitySelect = isAdmin || facilities.length > 1

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p className="text-xs font-semibold uppercase tracking-widest mb-1" style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}>
          Order History
        </p>
        <h1 className="text-3xl font-bold" style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}>
          発注履歴
        </h1>
      </div>

      <OrderHistoryFilters
        dateFrom={draftDateFrom}
        dateTo={draftDateTo}
        productSearch={draftProductSearch}
        selectedKinds={committed.kinds}
        onDateFromChange={setDraftDateFrom}
        onDateToChange={setDraftDateTo}
        onProductSearchChange={setDraftProductSearch}
        onKindsChange={handleKindsChange}
        onSearchSubmit={handleSearchSubmit}
        showFacilitySelect={showFacilitySelect}
        facilityOptions={facilities}
        selectedFacilityId={selectedFacilityId}
        onFacilityChange={handleFacilityChange}
        allowEmptyFacility={isAdmin}
      />

      {apiError && (
        <div
          role="alert"
          className="mb-4 flex items-center justify-between gap-4 rounded px-4 py-3 text-sm text-white"
          style={{ backgroundColor: '#DC2626' }}
        >
          <span>{apiError}</span>
          <button
            type="button"
            onClick={handleRetry}
            className="rounded bg-white px-3 py-1 text-xs font-semibold"
            style={{ color: '#DC2626' }}
          >
            リトライ
          </button>
        </div>
      )}

      {noFacilityAccess ? (
        <p className="px-6 py-8 text-center text-sm text-gray-500">
          所属施設がありません。管理者にお問い合わせください。
        </p>
      ) : (
        <OrderHistoryTable
          orders={orders}
          errors={fetchErrors}
          loading={displayLoading}
          showFacilityColumn={isAdmin}
          getDetailHref={detailHrefFor}
        />
      )}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-6 py-10">読み込み中...</div>}>
      <OrdersPageInner />
    </Suspense>
  )
}
