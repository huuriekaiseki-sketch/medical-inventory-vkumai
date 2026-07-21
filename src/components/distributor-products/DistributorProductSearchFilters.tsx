'use client'

import { useEffect, useRef, useState } from 'react'
import { KEYWORD_DEBOUNCE_MS } from '@/constants/search'
import type { Category } from '@/types/category'

type Props = {
  keyword: string
  categoryId: string
  categories: Category[] | undefined // undefined=ローディング中、[]=0件
  isLoading: boolean
  onKeywordChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onClear: () => void
}

const labelClass = 'text-xs font-semibold uppercase tracking-widest mb-1 block'
const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
const inputClass = 'rounded border px-3 py-2 text-sm'
const inputStyle = { borderColor: '#072C2C33', color: '#072C2C' }

export function DistributorProductSearchFilters({
  keyword,
  categoryId,
  categories,
  isLoading,
  onKeywordChange,
  onCategoryChange,
  onClear,
}: Props) {
  // WHY: OrderHistoryFilters.tsxと同じ「見た目は即時反映、親への通知だけdebounce」パターン。
  //      keyword propの外部変更（クリアボタン等）に追従させる必要があるが、useEffect内での
  //      setStateはreact-hooks/set-state-in-effectで禁止されているため、レンダー中に
  //      前回値と比較して同期するパターンを使う
  const [keywordInput, setKeywordInput] = useState(keyword)
  const [prevKeyword, setPrevKeyword] = useState(keyword)
  if (keyword !== prevKeyword) {
    setPrevKeyword(keyword)
    setKeywordInput(keyword)
  }
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  function handleKeywordChange(value: string) {
    setKeywordInput(value)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      onKeywordChange(value)
    }, KEYWORD_DEBOUNCE_MS)
  }

  // WHY: 入力直後（300ms以内）にクリアボタンを押すと、内部debounceタイマーが
  //      キャンセルされないまま生き残り、クリア後にタイマーが発火してonKeywordChangeが
  //      古い値で呼ばれ、キーワードが復活してしまう競合状態があった
  //      （レビュー指摘: 正しさ important）。クリア時は必ずタイマーを止めてから
  //      親のonClearを呼ぶ
  function handleClear() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current)
      debounceRef.current = null
    }
    setKeywordInput('')
    onClear()
  }

  const categoriesLoading = categories === undefined
  const categoryOptions = categories ?? []

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <div className="flex-1 min-w-[240px]">
        <label htmlFor="distributor-product-keyword" className={labelClass} style={labelStyle}>
          キーワード
        </label>
        <input
          id="distributor-product-keyword"
          type="text"
          value={keywordInput}
          onChange={(e) => handleKeywordChange(e.target.value)}
          placeholder="商品名・メーカー名・仕入先"
          maxLength={100}
          className={`${inputClass} w-full`}
          style={inputStyle}
        />
      </div>
      <div>
        <label htmlFor="distributor-product-category" className={labelClass} style={labelStyle}>
          カテゴリ
        </label>
        <select
          id="distributor-product-category"
          value={categoryId}
          onChange={(e) => onCategoryChange(e.target.value)}
          disabled={categoriesLoading || categoryOptions.length === 0}
          className={inputClass}
          style={inputStyle}
        >
          <option value="">すべてのカテゴリ</option>
          {categoryOptions.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        {categoriesLoading && (
          <p className="mt-1 text-xs" style={{ color: '#6B7280' }}>
            読み込み中…
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={handleClear}
        className="px-4 py-2 text-sm font-semibold rounded"
        style={{ border: '1px solid #072C2C33', color: '#072C2C' }}
      >
        クリア
      </button>
      {isLoading && (
        <span className="text-xs" style={{ color: '#6B7280' }}>
          読み込み中...
        </span>
      )}
    </div>
  )
}
