'use client'

import { useEffect, useRef, useState } from 'react'

type Props = {
  dateFrom: string
  dateTo: string
  keyword: string
  onDateFromChange: (value: string) => void
  onDateToChange: (value: string) => void
  onKeywordChange: (value: string) => void
  onClear: () => void
}

const labelClass = 'text-xs font-semibold uppercase tracking-widest mb-1 block'
const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
const inputClass = 'rounded border px-3 py-2 text-sm'
const inputStyle = { borderColor: '#072C2C33', color: '#072C2C' }

// WHY: キーワード入力のたびに親側でURL更新・API再取得が走ると、
//      1文字入力するごとに無駄なリクエストが発生する（issue #20 レビュー指摘: 正しさ minor）。
//      300ms入力が止まってからonKeywordChangeを呼ぶことでリクエスト数を抑える
const KEYWORD_DEBOUNCE_MS = 300

export function OrderHistoryFilters({
  dateFrom,
  dateTo,
  keyword,
  onDateFromChange,
  onDateToChange,
  onKeywordChange,
  onClear,
}: Props) {
  // WHY: 入力欄の見た目（keywordInput）は即座に更新し操作感を損なわないようにする一方、
  //      親への通知（onKeywordChange）だけをdebounceする。keyword propは
  //      クリアボタン等、外部からのリセットにも追従させる必要があるが、
  //      useEffect内でのsetStateはカスケード再レンダーを招くためlintで禁止されている
  //      （react-hooks/set-state-in-effect）。React公式が推奨する「レンダー中に前回値と
  //      比較して更新する」パターンで同期する
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

  return (
    <div className="mb-6 flex flex-wrap items-end gap-4">
      <div>
        <label htmlFor="order-date-from" className={labelClass} style={labelStyle}>開始日</label>
        <input
          id="order-date-from"
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <div>
        <label htmlFor="order-date-to" className={labelClass} style={labelStyle}>終了日</label>
        <input
          id="order-date-to"
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <div className="flex-1 min-w-[200px]">
        <label htmlFor="order-keyword" className={labelClass} style={labelStyle}>キーワード</label>
        <input
          id="order-keyword"
          type="text"
          value={keywordInput}
          onChange={(e) => handleKeywordChange(e.target.value)}
          placeholder="製品名・JAN・手技名など"
          className={`${inputClass} w-full`}
          style={inputStyle}
        />
      </div>
      <button
        type="button"
        onClick={onClear}
        className="px-4 py-2 text-sm font-semibold rounded"
        style={{ border: '1px solid #072C2C33', color: '#072C2C' }}
      >
        クリア
      </button>
    </div>
  )
}
