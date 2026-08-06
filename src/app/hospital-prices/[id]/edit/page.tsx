'use client'

import { use, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { HospitalPrice, HospitalPriceInput } from '@/types/hospitalPrice'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'
import type { FacilityRole } from '@/types/role'
import { HospitalPriceForm } from '@/components/hospitalPrices/HospitalPriceForm'

export default function EditHospitalPricePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const router = useRouter()
  const [price, setPrice] = useState<HospitalPrice | null>(null)
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [distributorProducts, setDistributorProducts] = useState<DistributorProduct[]>([])
  const [error, setError] = useState<string | null>(null)
  // WHY: viewerロールのUIゲーティング(issue #608)。undefinedは判定中(プレースホルダ)、
  // falseならフォームの代わりに閲覧専用メッセージを出す。
  const [canWrite, setCanWrite] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch(`/api/hospital-prices/${id}`).then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/facilities').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/distributor-products').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
    ]).then(([priceData, facilitiesData, dpData]) => {
      if (cancelled) return
      if (!priceData.price) {
        setError('価格情報が見つかりません')
        return
      }
      setPrice(priceData.price)
      setFacilities(facilitiesData.facilities)
      setDistributorProducts(dpData.items)

      const isAdmin = Boolean(facilitiesData.isAdmin)
      const roleByFacilityId = (facilitiesData.roleByFacilityId ?? {}) as Record<string, FacilityRole>
      const role = roleByFacilityId[priceData.price.facilityId as string]
      setCanWrite(isAdmin || role === 'admin' || role === 'staff')
    }).catch(() => {
      if (!cancelled) setError('データの取得に失敗しました')
    })
    return () => {
      cancelled = true
    }
  }, [id])

  async function handleSubmit(data: HospitalPriceInput) {
    setError(null)
    try {
      const res = await fetch(`/api/hospital-prices/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        if (res.status === 404) {
          setError('価格情報が見つかりません')
        } else if (res.status === 422) {
          setError('施設または代理店商品が存在しません')
        } else if (res.status === 409) {
          setError('この施設と商品の組み合わせは既に登録されています')
        } else {
          const body = await res.json()
          setError(body.error ?? '更新に失敗しました')
        }
        return
      }

      router.push('/hospital-prices')
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新に失敗しました')
    }
  }

  if (error && !price) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-red-600">{error}</p>
      </div>
    )
  }

  if (!price || canWrite === undefined) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <p className="text-gray-500">読み込み中...</p>
      </div>
    )
  }

  if (!canWrite) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-8">
        <Link href="/hospital-prices" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
          &larr; 一覧に戻る
        </Link>
        <p className="rounded-md bg-gray-100 px-4 py-3 text-sm text-gray-600">
          閲覧のみの権限のため、この価格情報を編集できません。
        </p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/hospital-prices" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">施設別価格編集</h1>
      {error && <p className="mb-4 text-red-600">{error}</p>}
      <div className="rounded-lg bg-white p-6 shadow">
        <HospitalPriceForm
          facilities={facilities}
          distributorProducts={distributorProducts}
          defaultValues={{
            facilityId: price.facilityId,
            distributorProductId: price.distributorProductId,
            purchasePrice: price.purchasePrice,
            deliveryPrice: price.deliveryPrice,
          }}
          onSubmit={handleSubmit}
          submitLabel="更新"
        />
      </div>
    </div>
  )
}
