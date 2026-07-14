import type { OrderKind } from '@/types/order'
import type { Facility } from '@/types/facility'

const KIND_OPTIONS: { kind: OrderKind; label: string }[] = [
  { kind: 'case', label: '症例発注' },
  { kind: 'consumable', label: '消耗品発注' },
  { kind: 'loan', label: '短貸発注' },
  { kind: 'loan_return', label: '短貸返却' },
]

type Props = {
  dateFrom: string
  dateTo: string
  productSearch: string
  selectedKinds: OrderKind[]
  onDateFromChange: (value: string) => void
  onDateToChange: (value: string) => void
  onProductSearchChange: (value: string) => void
  onKindsChange: (kinds: OrderKind[]) => void
  onSearchSubmit: () => void
  // WHY: 施設ドロップダウンの表示要否・選択肢・「全施設」オプションの有無は
  // admin/非admin判定のロジックを含むため、呼び出し元（/ordersページ）が算出して渡す
  showFacilitySelect: boolean
  facilityOptions: Facility[]
  selectedFacilityId: string
  onFacilityChange: (facilityId: string) => void
  allowEmptyFacility: boolean
}

export function OrderHistoryFilters({
  dateFrom,
  dateTo,
  productSearch,
  selectedKinds,
  onDateFromChange,
  onDateToChange,
  onProductSearchChange,
  onKindsChange,
  onSearchSubmit,
  showFacilitySelect,
  facilityOptions,
  selectedFacilityId,
  onFacilityChange,
  allowEmptyFacility,
}: Props) {
  function handleKindToggle(kind: OrderKind, checked: boolean) {
    if (checked) {
      onKindsChange([...selectedKinds, kind])
    } else {
      onKindsChange(selectedKinds.filter((k) => k !== kind))
    }
  }

  return (
    <form
      className="mb-6 flex flex-wrap items-end gap-4 rounded bg-white p-4 shadow-sm"
      style={{ border: '1px solid #E5E7EB' }}
      onSubmit={(e) => {
        e.preventDefault()
        onSearchSubmit()
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="order-history-date-from" className="text-xs font-medium text-gray-500">
          期間（開始）
        </label>
        <input
          id="order-history-date-from"
          type="date"
          value={dateFrom}
          onChange={(e) => onDateFromChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="order-history-date-to" className="text-xs font-medium text-gray-500">
          期間（終了）
        </label>
        <input
          id="order-history-date-to"
          type="date"
          value={dateTo}
          onChange={(e) => onDateToChange(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor="order-history-product-search" className="text-xs font-medium text-gray-500">
          製品名
        </label>
        <input
          id="order-history-product-search"
          type="text"
          value={productSearch}
          onChange={(e) => onProductSearchChange(e.target.value)}
          placeholder="製品名で絞り込み"
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        />
      </div>

      {showFacilitySelect && (
        <div className="flex flex-col gap-1">
          <label htmlFor="order-history-facility" className="text-xs font-medium text-gray-500">
            施設
          </label>
          <select
            id="order-history-facility"
            aria-label="施設"
            value={selectedFacilityId}
            onChange={(e) => onFacilityChange(e.target.value)}
            className="rounded border border-gray-300 px-2 py-1 text-sm"
          >
            {allowEmptyFacility && <option value="">全施設</option>}
            {facilityOptions.map((facility) => (
              <option key={facility.id} value={facility.id}>
                {facility.name}
              </option>
            ))}
          </select>
        </div>
      )}

      <fieldset className="flex flex-wrap gap-3">
        <legend className="mb-1 text-xs font-medium text-gray-500">発注種別</legend>
        {KIND_OPTIONS.map(({ kind, label }) => (
          <label key={kind} className="flex items-center gap-1 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={selectedKinds.includes(kind)}
              onChange={(e) => handleKindToggle(kind, e.target.checked)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <button
        type="submit"
        className="rounded bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
      >
        検索
      </button>
    </form>
  )
}
