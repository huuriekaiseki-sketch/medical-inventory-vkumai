import type { OrderKind } from '@/types/order'

// WHY: 発注種別ごとに色分けバッジを表示する。色はOrderButtons.tsxの発注種別ボタン色と
// 揃えることで、同じ種別が画面をまたいでも同じ色として認識できるようにする
const KIND_LABEL: Record<OrderKind, string> = {
  case: '症例発注',
  consumable: '消耗品発注',
  loan: '短貸発注',
  loan_return: '短貸返却',
}

const KIND_COLOR: Record<OrderKind, string> = {
  case: '#FF5F03',
  consumable: '#16A34A',
  loan: '#2563EB',
  loan_return: '#4B5563',
}

type Props = {
  kind: OrderKind
}

export function OrderKindBadge({ kind }: Props) {
  // WHY: UnifiedOrder.kindはAPI応答由来でTypeScriptの型保証が実行時に及ばないため、
  // 未知の値が来てもクラッシュせずそのまま表示するフォールバックを持たせる（防御的実装）
  const label = KIND_LABEL[kind] ?? kind
  const color = KIND_COLOR[kind] ?? '#6B7280'

  return (
    <span
      className="inline-block whitespace-nowrap rounded px-2 py-1 text-xs font-semibold text-white"
      style={{ backgroundColor: color }}
      aria-label={`種別: ${label}`}
    >
      {label}
    </span>
  )
}
