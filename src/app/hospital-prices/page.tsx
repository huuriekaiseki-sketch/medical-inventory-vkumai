'use client'

import { useEffect, useState, useReducer, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import type { HospitalPrice } from '@/types/hospitalPrice'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'
import { HospitalPriceList } from '@/components/hospitalPrices/HospitalPriceList'

export default function HospitalPricesPage() {
  const router = useRouter()
  const [prices, setPrices] = useState<HospitalPrice[]>([])
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [distributorProducts, setDistributorProducts] = useState<DistributorProduct[]>([])
  const [error, setError] = useState<string | null>(null)
  const [refreshKey, refresh] = useReducer((x: number) => x + 1, 0)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const facilitiesRes = await fetch('/api/facilities')
        if (!facilitiesRes.ok) throw new Error()
        const facilitiesData = await facilitiesRes.json()
        const loadedFacilities = facilitiesData.facilities as Facility[]
        const firstFacilityId = loadedFacilities[0]?.id

        const pricesPromise = firstFacilityId
          ? fetch(`/api/hospital-prices?facilityId=${encodeURIComponent(firstFacilityId)}`).then((r) => {
              if (!r.ok) throw new Error()
              return r.json()
            })
          : Promise.resolve({ prices: [] })
        const distributorProductsPromise = fetch('/api/distributor-products').then((r) => {
          if (!r.ok) throw new Error()
          return r.json()
        })

        const [pricesData, dpData] = await Promise.all([pricesPromise, distributorProductsPromise])
        if (cancelled) return
        setPrices(pricesData.prices)
        setFacilities(loadedFacilities)
        setDistributorProducts(dpData.items)
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [refreshKey])

  async function handleDelete(id: string) {
    setError(null)
    const res = await fetch(`/api/hospital-prices/${id}`, { method: 'DELETE' })
    if (!res.ok) {
      const body = await res.json()
      setError(body.error ?? '削除に失敗しました')
      return
    }
    refresh()
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

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">施設別価格管理</h1>
        <button
          onClick={() => router.push('/hospital-prices/new')}
          className="rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          + 新規価格を登録
        </button>
      </div>

      {error && <p className="mb-4 text-red-600">{error}</p>}

      <div className="rounded-lg bg-white shadow">
        <HospitalPriceList
          prices={resolvedPrices}
          onEdit={(id) => router.push(`/hospital-prices/${id}/edit`)}
          onDelete={handleDelete}
        />
      </div>
    </div>
  )
}
