'use client'

import { use, useId, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import type { LotSearchApiResponse, LotSearchResultItem } from '@/types/order'
import { formatJstDateTime } from '@/lib/format-date'
import { normalizeLotInput } from '@/lib/lot-search/normalize'

// WHY(issue #803 決定6=(a)): 一覧に患者情報を出さない。ラベルは種別を色だけでなく
//      文字でも区別する（受け入れ条件「種別は色だけでなく文字でも区別」）。
const KIND_LABEL: Record<LotSearchResultItem['kind'], string> = {
  case_order: '症例発注',
  loan_return: '短貸返却',
}
const KIND_COLOR: Record<LotSearchResultItem['kind'], string> = {
  case_order: '#B03F00',
  loan_return: '#4B5563',
}
const KIND_LINK_PATH: Record<LotSearchResultItem['kind'], string> = {
  case_order: 'case-orders',
  loan_return: 'loan-returns',
}
// WHY(レビュー指摘の修正、受け入れ条件「各行から元の発注・返却へ辿れる」): これまで
//      parentId(元の発注・返却のid)が型に載っているのに一覧ページへの固定リンクしか
//      作っておらず、実質「どの行だったか」が辿れなかった。一覧ページ側の行に
//      同じ規則の id(下のANCHOR_PREFIX-<id>)を振り、URLフラグメントでその行まで
//      直接辿れるようにする(ページ側にJSの状態を増やさずブラウザの標準機能で解決する)。
const ANCHOR_PREFIX: Record<LotSearchResultItem['kind'], string> = {
  case_order: 'order',
  loan_return: 'return',
}

// WHY(決定4): 検証環境の500件上限と揃える。UI側は超過の有無(truncated)だけを見る。
const LOT_MAX_LENGTH = 100
const LOT_MIN_LENGTH = 1
const LENGTH_ERROR_MESSAGE = '1〜100字で入力してください'
const GENERIC_ERROR_MESSAGE = '検索に失敗しました'

type SearchState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'done'; items: LotSearchResultItem[]; truncated: boolean }

export default function LotSearchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const [lot, setLot] = useState('')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [state, setState] = useState<SearchState>({ status: 'idle' })
  const inputId = useId()
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null)

  async function handleSearch(e: FormEvent) {
    e.preventDefault()
    // WHY(決定3=(b)): 表記ゆれの吸収は「前後の空白を落とす」だけ。規則は normalizeLotInput の 1 か所に置き、
    //      UI と API(route.ts) の両方が同じ関数を呼ぶ（SPEC Part 2）。ここで独自に trim すると、
    //      規則を (c) へ広げたときに画面側だけ古い規則で長さ判定をすることになる
    const trimmed = normalizeLotInput(lot)
    if (trimmed.length < LOT_MIN_LENGTH || trimmed.length > LOT_MAX_LENGTH) {
      setValidationError(LENGTH_ERROR_MESSAGE)
      return
    }
    setValidationError(null)
    setState({ status: 'loading' })
    try {
      const res = await fetch(`/api/facilities/${id}/lot-search?lot=${encodeURIComponent(trimmed)}`)
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: GENERIC_ERROR_MESSAGE }))
        setState({ status: 'error', message: body.error ?? GENERIC_ERROR_MESSAGE })
        return
      }
      const data: LotSearchApiResponse = await res.json()
      setState({ status: 'done', items: data.items, truncated: data.truncated })
      // WHY(a11y): 検索結果に切り替わったことをキーボード利用者にも伝えるため、
      //      見出しへフォーカスを移す（受け入れ条件「結果へのフォーカス移動」）。
      requestAnimationFrame(() => resultsHeadingRef.current?.focus())
    } catch {
      setState({ status: 'error', message: GENERIC_ERROR_MESSAGE })
    }
  }

  const isLoading = state.status === 'loading'
  const labelStyle = { color: '#4B5563', fontFamily: 'var(--font-oswald), sans-serif' }

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <Link href={`/facilities/${id}`} className="text-sm hover:underline" style={{ color: '#4B5563' }}>
          ← 施設に戻る
        </Link>
      </div>

      <div className="mb-8 border-b pb-4" style={{ borderColor: '#072C2C33' }}>
        <p
          className="text-xs font-semibold uppercase tracking-widest mb-1"
          style={{ ...labelStyle, color: '#7C3AED' }}
        >
          Lot Search
        </p>
        <h1
          className="text-3xl font-bold"
          style={{ color: '#072C2C', fontFamily: 'var(--font-oswald), sans-serif', letterSpacing: '0.04em' }}
        >
          ロット検索
        </h1>
        <p className="mt-2 text-sm" style={{ color: '#4B5563' }}>
          症例発注・短貸返却の明細をロット番号で検索します。
          短貸発注の明細（ロット番号を記録していません）は対象外です。
        </p>
      </div>

      <form onSubmit={handleSearch} className="mb-6 flex flex-wrap items-start gap-3">
        <div>
          <label htmlFor={inputId} className="mb-1 block text-xs font-semibold uppercase tracking-widest" style={labelStyle}>
            ロット番号
          </label>
          <input
            id={inputId}
            type="text"
            value={lot}
            onChange={(e) => setLot(e.target.value)}
            aria-invalid={validationError ? true : undefined}
            aria-describedby={validationError ? `${inputId}-error` : undefined}
            className="rounded border px-3 py-2 text-sm"
            style={{ borderColor: '#E5E7EB' }}
          />
          {validationError && (
            <p id={`${inputId}-error`} className="mt-1 text-sm" style={{ color: '#DC2626' }}>
              {validationError}
            </p>
          )}
        </div>
        <button
          type="submit"
          disabled={isLoading}
          className="mt-6 px-4 py-2 text-sm font-semibold rounded text-white hover:opacity-90 disabled:opacity-50"
          style={{ backgroundColor: '#7C3AED' }}
        >
          {isLoading ? '検索中…' : '検索する'}
        </button>
      </form>

      {state.status === 'error' && (
        <div className="mb-4 px-4 py-3 rounded text-sm text-white" style={{ backgroundColor: '#DC2626' }}>
          {state.message}
        </div>
      )}

      {state.status === 'loading' && (
        <p className="text-sm" style={{ color: '#4B5563' }}>検索中...</p>
      )}

      {state.status === 'done' && (
        <>
          {/* WHY: 視覚的な見出しは出さず(結果テーブル自体が見出し代わり)、フォーカス移動先としてのみ使う */}
          <h2 ref={resultsHeadingRef} tabIndex={-1} className="sr-only">
            検索結果
          </h2>

          {state.truncated && (
            <div
              className="mb-4 px-4 py-3 rounded text-sm"
              style={{ backgroundColor: '#FEF3C7', color: '#92400E', border: '1px solid #FDE68A' }}
              role="status"
            >
              該当が多いため一部のみ表示しています。ロット番号を長くして絞り込んでください。
            </div>
          )}

          {state.items.length === 0 ? (
            <p className="text-sm" style={{ color: '#4B5563' }}>該当するロットは見つかりませんでした</p>
          ) : (
            <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
              <table className="min-w-full">
                <thead>
                  <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>種別</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>ロット</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>JAN</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>数量</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>日付</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>元へ</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => (
                    <tr key={`${item.kind}-${item.itemId}`} style={{ borderBottom: '1px solid #E5E7EB' }}>
                      <td className="px-6 py-4 text-sm font-semibold" style={{ color: KIND_COLOR[item.kind] }}>
                        {KIND_LABEL[item.kind]}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                        {item.lot}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                        {item.jan}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#4B5563' }}>{item.quantity}</td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#4B5563', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                        {formatJstDateTime(item.occurredAt)}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <Link
                          href={`/facilities/${id}/${KIND_LINK_PATH[item.kind]}#${ANCHOR_PREFIX[item.kind]}-${item.parentId}`}
                          className="hover:underline"
                          style={{ color: '#2563EB' }}
                        >
                          元へ
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
