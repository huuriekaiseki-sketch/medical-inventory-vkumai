'use client'

import { use, useId, useRef, useState, type FormEvent } from 'react'
import Link from 'next/link'
import type { LotSearchApiResponse, LotSearchResultItem } from '@/types/order'
import { formatJstDateTime } from '@/lib/format-date'
import { normalizeLotInput } from '@/lib/lot-search/normalize'
import { LOT_LENGTH_ERROR_MESSAGE, LOT_MAX_LENGTH, LOT_MIN_LENGTH } from '@/lib/lot-search/limits'

// WHY(issue #803 決定 6。2026-09-19 に (a)→(b) へ決め直した): 症例発注の行には**患者 ID とイニシャル**を出す。
//      最初は「出さない。発注を開けば分かる」で承認されたが、発注の詳細ページは存在せず、登録後に患者の情報が出る画面は
//      1 つも無かった（停止②で判明）。リコール対応の目的は「どの患者に使ったか」の特定なので、ここに出さないと果たせない。
//      医師名・性別・術式名は出さない（API も返さない）。
//      ラベルは種別を色だけでなく文字でも区別する（受け入れ条件「種別は色だけでなく文字でも区別」）。
const KIND_LABEL: Record<LotSearchResultItem['kind'], string> = {
  case_order: '症例発注',
  loan_return: '短貸返却',
}
const KIND_COLOR: Record<LotSearchResultItem['kind'], string> = {
  case_order: '#B03F00',
  loan_return: '#4B5563',
}
// WHY(issue #809 セットC): issue #803 でやめた行ごとのリンクを、詳細ページ宛てで復活させる。
//      #803 当時は一覧ページの行（#order-<id>）へ飛ぶ作りで、一覧が最新50件だけしか持たないため
//      「踏んでも何も起きないリンク」になっていた。今は ID を指定して1件だけ取る詳細ページがあるので、
//      `parentId`（症例発注/短貸返却そのもののID）で確実に辿れる。`#` つきのリンクにはしない。
//      種別ごとの一覧へのリンクは、詳細ページから一覧へ戻れるので外す（SPEC Part2 セットC）。
const KIND_DETAIL_PATH: Record<LotSearchResultItem['kind'], string> = {
  case_order: 'case-orders',
  loan_return: 'loan-returns',
}

// WHY(決定4): 検証環境の500件上限と揃える。UI側は超過の有無(truncated)だけを見る。
// WHY(issue #814): 長さの上限はこの画面で持たない。設定（API 側と同じ値）との一致をテストで
//      固定した定数を読む。理由と、設定を直接読まない事情は @/lib/lot-search/limits を参照
const LENGTH_ERROR_MESSAGE = LOT_LENGTH_ERROR_MESSAGE
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
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>患者ID</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>イニシャル</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest" style={labelStyle}>詳細</th>
                  </tr>
                </thead>
                <tbody>
                  {state.items.map((item) => (
                    <tr key={`${item.kind}-${item.itemId}`} style={{ borderBottom: '1px solid #E5E7EB' }}>
                      <td className="px-6 py-4 text-sm font-semibold" style={{ color: KIND_COLOR[item.kind] }}>
                        {KIND_LABEL[item.kind]}
                        {/* WHY(停止②で判明): 取り消しは「その返却の記録は誤りだった」＝実際には返していないかもしれない。
                            区別なく「短貸返却」と出すと、返却済みと読んで院内に残ったロットを取りこぼす。
                            行は落とさず、色に頼らず文字で、何を意味するかまで書く */}
                        {item.kind === 'loan_return' && item.cancelled && (
                          <span className="mt-1 block text-xs font-normal" style={{ color: '#B91C1C' }}>
                            <strong className="font-semibold">取り消し済み</strong>
                            <span className="block">実際には返却されていない可能性があります</span>
                          </span>
                        )}
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
                      {/* WHY(「—」を出す): 短貸返却は患者に紐づかない。空欄にすると「出し忘れ」と「該当なし」を見分けられない */}
                      <td className="px-6 py-4 text-sm" style={{ color: '#111827', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                        {item.kind === 'case_order' ? item.patientId : '—'}
                      </td>
                      <td className="px-6 py-4 text-sm" style={{ color: '#111827' }}>
                        {item.kind === 'case_order' ? item.patientInitials : '—'}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <Link
                          href={`/facilities/${id}/${KIND_DETAIL_PATH[item.kind]}/${item.parentId}`}
                          className="hover:underline"
                          style={{ color: '#2563EB' }}
                        >
                          詳細を見る
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
