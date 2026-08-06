'use client'

import { Suspense, useEffect, useState, useReducer, useMemo } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { HospitalPrice } from '@/types/hospitalPrice'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'
import { HospitalPriceList } from '@/components/hospitalPrices/HospitalPriceList'

function HospitalPricesPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlFacilityId = searchParams.get('facilityId')

  const [prices, setPrices] = useState<HospitalPrice[]>([])
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [distributorProducts, setDistributorProducts] = useState<DistributorProduct[]>([])
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)
  const [isAdmin, setIsAdmin] = useState(false)
  const [roleByFacilityId, setRoleByFacilityId] = useState<Record<string, 'admin' | 'staff' | 'viewer'>>({})

  // 初回ロード用: facilities・distributorProducts を取得し、選択施設IDを決定する
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const [facilitiesRes, distributorProductsRes] = await Promise.all([
          fetch('/api/facilities'),
          fetch('/api/distributor-products'),
        ])
        if (!facilitiesRes.ok) throw new Error()
        if (!distributorProductsRes.ok) throw new Error()
        const facilitiesData = await facilitiesRes.json()
        const dpData = await distributorProductsRes.json()
        const loadedFacilities = facilitiesData.facilities as Facility[]
        if (cancelled) return

        setFacilities(loadedFacilities)
        setDistributorProducts(dpData.items)
        setIsAdmin(Boolean(facilitiesData.isAdmin))
        setRoleByFacilityId(facilitiesData.roleByFacilityId ?? {})

        const isValidUrlFacility =
          urlFacilityId !== null && loadedFacilities.some((f) => f.id === urlFacilityId)
        const resolvedFacilityId = isValidUrlFacility
          ? urlFacilityId
          : (loadedFacilities[0]?.id ?? null)

        setSelectedFacilityId(resolvedFacilityId)

        if (resolvedFacilityId !== urlFacilityId) {
          if (resolvedFacilityId) {
            router.replace(`/hospital-prices?facilityId=${encodeURIComponent(resolvedFacilityId)}`)
          }
        }
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey])

  // 価格取得用: selectedFacilityId が変わるたびに（削除後の再取得も含め）価格一覧を取得する
  useEffect(() => {
    let cancelled = false
    async function loadPrices() {
      if (!selectedFacilityId) {
        setPrices([])
        return
      }
      try {
        const res = await fetch(`/api/hospital-prices?facilityId=${encodeURIComponent(selectedFacilityId)}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setPrices(data.prices)
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    loadPrices()
    return () => {
      cancelled = true
    }
  }, [selectedFacilityId, refreshKey])

  async function handleDelete(id: string) {
    setError(null)
    try {
      const res = await fetch(`/api/hospital-prices/${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const body = await res.json()
        setError(body.error ?? '削除に失敗しました')
        return
      }
      refresh()
    } catch {
      setError('削除に失敗しました')
    }
  }

  function handleFacilityChange(newId: string) {
    setSelectedFacilityId(newId)
    router.replace(`/hospital-prices?facilityId=${encodeURIComponent(newId)}`)
  }

  const facilityNameById = useMemo(
    () => new Map(facilities.map((f) => [f.id, f.name])),
    [facilities]
  )
  const productNameById = useMemo(
    () => new Map(distributorProducts.map((dp) => [dp.id, dp.name])),
    [distributorProducts]
  )
  const resolvedPrices = useMemo(
    () =>
      prices.map((price) => ({
        ...price,
        facilityName: facilityNameById.get(price.facilityId) ?? '不明',
        productName: productNameById.get(price.distributorProductId) ?? '不明',
      })),
    [prices, facilityNameById, productNameById]
  )

  // WHY: viewerロールのUIゲーティング(issue #608)。選択中施設でのroleがadmin/staffの
  // 場合のみ書き込み操作(新規登録・編集・削除)のUIを出す。実際の拒否はRLSが最終的に
  // 担保するため、ここでは「表示するかどうか」の判定のみ。
  const canWrite =
    isAdmin ||
    (selectedFacilityId !== null &&
      (roleByFacilityId[selectedFacilityId] === 'admin' || roleByFacilityId[selectedFacilityId] === 'staff'))

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">施設別価格管理</h1>
        {canWrite && (
          <button
            onClick={() => router.push('/hospital-prices/new')}
            className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            + 新規価格を登録
          </button>
        )}
      </div>

      <div className="mb-4">
        <label htmlFor="facility-select" className="sr-only">
          施設を選択
        </label>
        <select
          id="facility-select"
          value={selectedFacilityId ?? ''}
          onChange={(e) => handleFacilityChange(e.target.value)}
          className="rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {facilities.map((facility) => (
            <option key={facility.id} value={facility.id}>
              {facility.name}
            </option>
          ))}
        </select>
      </div>

      {error && <p className="mb-4 text-red-600">{error}</p>}

      <div className="rounded-lg bg-white shadow">
        <HospitalPriceList
          prices={resolvedPrices}
          onEdit={(id) => router.push(`/hospital-prices/${id}/edit`)}
          onDelete={handleDelete}
          canWrite={canWrite}
        />
      </div>
    </div>
  )
}

export default function HospitalPricesPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-5xl px-4 py-8">読み込み中...</div>}>
      <HospitalPricesPageInner />
    </Suspense>
  )
}
