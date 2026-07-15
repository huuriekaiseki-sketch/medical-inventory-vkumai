'use client'

import type { OrderAmountReportRow } from '@/types/report'

// WHY: issue #23 Part2 Set E。未解決事項4のNULL/¥0/「-」表示区分ルールを実装する。
//      当初は「発注0件」と「発注はあるが単価データなし」をamount=NULL・count=0のみで
//      判定しており、種別単位で両者を区別できず、行全体がNULLのときも「本当に発注が0件」と
//      誤判定する不具合があった（コードレビュー指摘: critical）。
//      `get_order_amount_report`RPCが返す*_totalCount（価格の有無を問わない全明細件数）を使い、
//      種別ごとに totalCount === 0 なら「発注0件」、totalCount > 0 かつ amount === null なら
//      「発注はあるが単価データなし」と判定する（SPEC.md Part2 Set B参照）。

const labelStyle = { color: '#6B7280', fontFamily: 'var(--font-oswald), sans-serif' }

// WHY: 単価スナップショットはこの日付以降に作成された発注にのみ存在する
// （supabase/migrations/20260715000001_add_unit_price_to_order_items.sql 適用日）。
const UNIT_PRICE_SNAPSHOT_START_DATE = '2026-07-15'

function formatYen(amount: number): string {
  return `¥${amount.toLocaleString('ja-JP')}`
}

// WHY: 種別ごとの「発注0件」判定は totalCount(価格の有無を問わない全明細件数)のみで行う。
//      count(単価データがある明細の件数)はamount集計に使われた件数であり、
//      「発注はあるが単価データなし」の場合も0になるため、この判定には使えない。
function hasNoOrdersInCategory(totalCount: number): boolean {
  return totalCount === 0
}

function hasNoOrdersAtAll(row: OrderAmountReportRow): boolean {
  return (
    hasNoOrdersInCategory(row.caseOrderTotalCount) &&
    hasNoOrdersInCategory(row.consumableOrderTotalCount) &&
    hasNoOrdersInCategory(row.loanOrderTotalCount)
  )
}

// WHY(important指摘対応・追加分): 「発注はあるが単価データが一切ない」施設が
//      全種別に及ぶ場合（=いずれの種別も amount===null）、hasNoOrdersAtAll は
//      false になるため合計を¥0として計算してしまうが、これは「確定0円」ではなく
//      「金額が不明」であり誤解を招く。少なくとも1種別に発注があり(totalCount>0)、
//      かつどの種別にも金額データが一切ない(全amountがnull)場合は合計も
//      「-（金額データなし）」と表示する。
function hasNoAmountDataAtAll(row: OrderAmountReportRow): boolean {
  return (
    row.caseOrderAmount === null &&
    row.consumableOrderAmount === null &&
    row.loanOrderAmount === null
  )
}

function formatCell(amount: number | null, totalCount: number): string {
  if (hasNoOrdersInCategory(totalCount)) return '-'
  if (amount === null) return '-（金額データなし）'
  return formatYen(amount)
}

// WHY(important指摘対応): 合計は「全種別が発注0件」の場合のみ「-」とし、それ以外は
//      各種別のNULL（発注はあるが単価データなし、または発注0件で結果的にamount=null）を
//      0とみなして加算する（SPEC.md Part2「集計テーブル」受け入れ条件のとおり）。
//      hasNoOrdersAtAllをtotalCountベースに修正したことで、「一部の種別だけ単価データなし」の
//      行を誤って「全種別発注0件」と判定してしまう境界条件の欠落も併せて解消している。
//      さらに、発注はあるが全種別で単価データが一切ない場合（hasNoAmountDataAtAll）は
//      「-（金額データなし）」を優先し、確定0円である「¥0」と誤表示しない。
function formatTotal(row: OrderAmountReportRow): string {
  if (hasNoOrdersAtAll(row)) return '-'
  if (hasNoAmountDataAtAll(row)) return '-（金額データなし）'
  const total = (row.caseOrderAmount ?? 0) + (row.consumableOrderAmount ?? 0) + (row.loanOrderAmount ?? 0)
  return formatYen(total)
}

type Props = {
  rows: OrderAmountReportRow[]
}

export function ReportTable({ rows }: Props) {
  return (
    <div>
      <div className="rounded bg-white shadow-sm overflow-hidden" style={{ border: '1px solid #E5E7EB' }}>
        <div className="overflow-x-auto">
          <table className="min-w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: '#F9FAFB' }}>
                <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>施設名</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>症例発注金額</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>消耗品発注金額</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>短貸発注金額</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-widest whitespace-nowrap" style={labelStyle}>合計</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                return (
                  <tr key={row.facilityId} style={{ borderBottom: '1px solid #E5E7EB' }}>
                    <td className="px-6 py-4 text-sm font-medium whitespace-nowrap" style={{ color: '#111827' }}>{row.facilityName}</td>
                    <td className="px-6 py-4 text-sm text-right whitespace-nowrap" style={{ color: '#072C2C' }}>
                      {formatCell(row.caseOrderAmount, row.caseOrderTotalCount)}
                    </td>
                    <td className="px-6 py-4 text-sm text-right whitespace-nowrap" style={{ color: '#072C2C' }}>
                      {formatCell(row.consumableOrderAmount, row.consumableOrderTotalCount)}
                    </td>
                    <td className="px-6 py-4 text-sm text-right whitespace-nowrap" style={{ color: '#072C2C' }}>
                      {formatCell(row.loanOrderAmount, row.loanOrderTotalCount)}
                    </td>
                    <td className="px-6 py-4 text-sm text-right font-semibold whitespace-nowrap" style={{ color: '#072C2C' }}>
                      {formatTotal(row)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="mt-3 text-xs" style={{ color: '#6B7280' }}>
        {UNIT_PRICE_SNAPSHOT_START_DATE}以前の発注は金額データがありません
      </p>
    </div>
  )
}
