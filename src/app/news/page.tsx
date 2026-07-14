'use client'

import { Suspense, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { Facility } from '@/types/facility'
import type { NewsFeedItem } from '@/types/newsFeedItem'
import { NewsFeedList } from '@/components/news/NewsFeedList'

const PAGE_SIZE = 20

function NewsPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const urlFacilityId = searchParams.get('facilityId')

  const [facilities, setFacilities] = useState<Facility[]>([])
  const [isAdmin, setIsAdmin] = useState(false)
  const [initialized, setInitialized] = useState(false)
  const [selectedFacilityId, setSelectedFacilityId] = useState<string | null>(null)
  const [items, setItems] = useState<NewsFeedItem[]>([])
  const [offset, setOffset] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 初回ロード用: facilities を取得し、選択施設IDを決定する
  // 管理者はURLで施設が指定されていなければ「全施設」（selectedFacilityId=null）をデフォルトにする（issue #40）
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/facilities')
        if (!res.ok) throw new Error()
        const data = await res.json()
        const loadedFacilities = data.facilities as Facility[]
        const admin = Boolean(data.isAdmin)
        if (cancelled) return

        setFacilities(loadedFacilities)
        setIsAdmin(admin)

        const isValidUrlFacility =
          urlFacilityId !== null && loadedFacilities.some((f) => f.id === urlFacilityId)
        const resolvedFacilityId = isValidUrlFacility
          ? urlFacilityId
          : admin
            ? null
            : (loadedFacilities[0]?.id ?? null)

        setSelectedFacilityId(resolvedFacilityId)
        setInitialized(true)

        if (resolvedFacilityId !== urlFacilityId && resolvedFacilityId) {
          router.replace(`/news?facilityId=${encodeURIComponent(resolvedFacilityId)}`)
        }

        setError(null)
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    load()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // フィード取得用: selectedFacilityId が変わるたびに1ページ目から取得する
  // 管理者がselectedFacilityId=null（全施設）の場合はfacilityIdを付与せず取得する
  useEffect(() => {
    let cancelled = false
    async function loadFeed() {
      if (!initialized) return
      if (!selectedFacilityId && !isAdmin) {
        setItems([])
        setHasMore(false)
        setError(null)
        return
      }
      try {
        const query = selectedFacilityId
          ? `facilityId=${encodeURIComponent(selectedFacilityId)}&limit=${PAGE_SIZE}&offset=0`
          : `limit=${PAGE_SIZE}&offset=0`
        const res = await fetch(`/api/news?${query}`)
        if (!res.ok) throw new Error()
        const data = await res.json()
        if (cancelled) return
        setItems(data.items)
        setOffset(PAGE_SIZE)
        setHasMore(data.items.length === PAGE_SIZE)
        setError(null)
      } catch {
        if (!cancelled) setError('データの取得に失敗しました')
      }
    }
    loadFeed()
    return () => {
      cancelled = true
    }
  }, [selectedFacilityId, isAdmin, initialized])

  async function handleLoadMore() {
    if (!selectedFacilityId && !isAdmin) return
    try {
      const query = selectedFacilityId
        ? `facilityId=${encodeURIComponent(selectedFacilityId)}&limit=${PAGE_SIZE}&offset=${offset}`
        : `limit=${PAGE_SIZE}&offset=${offset}`
      const res = await fetch(`/api/news?${query}`)
      if (!res.ok) throw new Error()
      const data = await res.json()
      setItems((prev) => [...prev, ...data.items])
      setOffset((prev) => prev + PAGE_SIZE)
      setHasMore(data.items.length === PAGE_SIZE)
      setError(null)
    } catch {
      setError('データの取得に失敗しました')
    }
  }

  function handleFacilityChange(newId: string) {
    // 空文字は「全施設」選択（管理者のみ選択肢として表示）を表す
    const resolved = newId === '' ? null : newId
    setSelectedFacilityId(resolved)
    if (resolved) {
      router.replace(`/news?facilityId=${encodeURIComponent(resolved)}`)
    } else {
      router.replace('/news')
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-8 border-b pb-4 flex items-end justify-between" style={{ borderColor: '#072C2C33' }}>
        <div>
          <p
            className="text-xs font-semibold uppercase tracking-widest mb-1"
            style={{ color: '#FF5F03', fontFamily: 'var(--font-oswald), sans-serif' }}
          >
            Information
          </p>
          <h1
            className="text-3xl font-bold"
            style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
          >
            ニュース
          </h1>
        </div>
        <div>
          <label htmlFor="facility-select" className="sr-only">
            施設を選択
          </label>
          <select
            id="facility-select"
            value={selectedFacilityId ?? ''}
            onChange={(e) => handleFacilityChange(e.target.value)}
            className="rounded border px-3 py-2 text-sm"
            style={{ borderColor: '#072C2C33', color: '#072C2C' }}
          >
            {isAdmin && <option value="">全施設</option>}
            {facilities.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <p className="mb-4 text-sm" style={{ color: '#DC2626' }}>
          {error}
        </p>
      )}

      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <NewsFeedList items={items} />
      </div>

      {hasMore && (
        <div className="mt-6 flex justify-center">
          <button
            onClick={handleLoadMore}
            className="rounded px-6 py-2 text-sm font-semibold uppercase tracking-widest"
            style={{ border: '1px solid #072C2C33', color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif' }}
          >
            もっと見る
          </button>
        </div>
      )}
    </div>
  )
}

export default function NewsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-6 py-10">読み込み中...</div>}>
      <NewsPageInner />
    </Suspense>
  )
}
