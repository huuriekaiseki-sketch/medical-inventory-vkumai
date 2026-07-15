'use client'

import { useState } from 'react'

// WHY: issue #23 Part2 Set E。期間フィルタUI。「集計する」ボタン押下時のみonSubmitを呼び、
//      開始日>終了日のバリデーションはAPIを呼ぶ前にここで弾く（受け入れ条件チェックリスト「期間フィルタ」）。

type Props = {
  dateFrom: string
  dateTo: string
  onSubmit: (filter: { dateFrom: string; dateTo: string }) => void
}

const labelClass = 'text-xs font-semibold uppercase tracking-widest mb-1 block'
const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }
const inputClass = 'rounded border px-3 py-2 text-sm'
const inputStyle = { borderColor: '#072C2C33', color: '#072C2C' }

export function ReportFilters({ dateFrom, dateTo, onSubmit }: Props) {
  // WHY: URLパラメータ変更でも集計テーブルが更新される仕様(SPEC Part1「操作の流れ」3)のため、
  //      入力欄自体はローカルstateで持ちつつ、propsのdateFrom/dateToを初期値として使う。
  const [dateFromInput, setDateFromInput] = useState(dateFrom)
  const [dateToInput, setDateToInput] = useState(dateTo)
  const [error, setError] = useState<string | null>(null)

  function handleSubmit() {
    if (dateFromInput && dateToInput && dateFromInput > dateToInput) {
      setError('開始日は終了日より前の日付を指定してください')
      return
    }
    setError(null)
    onSubmit({ dateFrom: dateFromInput, dateTo: dateToInput })
  }

  return (
    <div className="mb-6">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label htmlFor="report-date-from" className={labelClass} style={labelStyle}>開始日</label>
          <input
            id="report-date-from"
            type="date"
            value={dateFromInput}
            onChange={(e) => setDateFromInput(e.target.value)}
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <div>
          <label htmlFor="report-date-to" className={labelClass} style={labelStyle}>終了日</label>
          <input
            id="report-date-to"
            type="date"
            value={dateToInput}
            onChange={(e) => setDateToInput(e.target.value)}
            className={inputClass}
            style={inputStyle}
          />
        </div>
        <button
          type="button"
          onClick={handleSubmit}
          className="px-4 py-2 text-sm font-semibold text-white rounded"
          style={{ backgroundColor: '#FF5F03' }}
        >
          集計する
        </button>
      </div>
      {error && (
        <p className="mt-2 text-sm" style={{ color: '#DC2626' }}>
          {error}
        </p>
      )}
    </div>
  )
}
