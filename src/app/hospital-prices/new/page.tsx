'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import type { HospitalPriceInput } from '@/types/hospitalPrice'
import type { Facility } from '@/types/facility'
import type { DistributorProduct } from '@/types/distributorProduct'
import type { FacilityRole } from '@/types/role'
import { HospitalPriceForm } from '@/components/hospitalPrices/HospitalPriceForm'

export default function NewHospitalPricePage() {
  const router = useRouter()
  const [facilities, setFacilities] = useState<Facility[]>([])
  const [distributorProducts, setDistributorProducts] = useState<DistributorProduct[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([
      fetch('/api/facilities').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
      fetch('/api/distributor-products').then((r) => { if (!r.ok) throw new Error(); return r.json() }),
    ]).then(([facilitiesData, dpData]) => {
      if (cancelled) return
      // WHY: viewerロールのUIゲーティング(issue #608)。施設選択はこのフォーム内で
      // 行われるため、あらかじめviewerの施設を選択肢から除外する(選んだ後にRLSで
      // 拒否されるより、そもそも選べない方が分かりやすい)。実際の書き込み拒否は
      // 引き続きRLS/RPCが最終防衛として担保する。
      const isAdmin = Boolean(facilitiesData.isAdmin)
      const roleByFacilityId = (facilitiesData.roleByFacilityId ?? {}) as Record<string, FacilityRole>
      const writableFacilities = isAdmin
        ? facilitiesData.facilities
        : (facilitiesData.facilities as Facility[]).filter((f) => {
            const role = roleByFacilityId[f.id]
            return role === 'admin' || role === 'staff'
          })
      setFacilities(writableFacilities)
      setDistributorProducts(dpData.items)
    }).catch(() => {
      if (!cancelled) setError('データの取得に失敗しました')
    })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSubmit(data: HospitalPriceInput) {
    setError(null)
    try {
      const res = await fetch('/api/hospital-prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })

      if (!res.ok) {
        if (res.status === 409) {
          setError('この施設と商品の組み合わせは既に登録されています')
        } else if (res.status === 422) {
          setError('施設または代理店商品が存在しません')
        } else {
          const body = await res.json()
          setError(body.error ?? '登録に失敗しました')
        }
        return
      }

      router.push('/hospital-prices')
    } catch (err) {
      setError(err instanceof Error ? err.message : '登録に失敗しました')
    }
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/hospital-prices" className="mb-4 inline-block text-sm text-blue-600 hover:text-blue-800">
        &larr; 一覧に戻る
      </Link>
      <h1 className="mb-6 text-2xl font-bold text-gray-900">施設別価格登録</h1>
      {error && <p className="mb-4 text-red-600">{error}</p>}
      <div className="rounded-lg bg-white p-6 shadow">
        <HospitalPriceForm
          facilities={facilities}
          distributorProducts={distributorProducts}
          onSubmit={handleSubmit}
          submitLabel="登録"
        />
      </div>
    </div>
  )
}
