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
