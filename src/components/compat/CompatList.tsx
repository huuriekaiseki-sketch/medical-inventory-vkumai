'use client'

import type { ProductCompatibility } from '@/types/compatibility'

type CompatListProps = {
  items: ProductCompatibility[]
  isAdmin: boolean
  onDelete: (id: string) => void
  hasFilter: boolean
  // WHY: 一覧再取得中はテーブル領域を明示的にスケルトン表示するため。
  // Set E の props 一覧には明記されていないが、SPEC「UI」受け入れ条件
  // （一覧初回表示・再取得中のスケルトン/スピナー表示）を満たすために
  // optionalとして追加する（既存propsの意味は変えていない）。
  isLoading?: boolean
  // WHY: 全体0件かつ管理者向けの「＋互換品を追加」導線から、
  // ページ側の登録フォーム展開処理を呼べるようにするためのoptional callback。
  onAddClick?: () => void
}

function formatProductLabel(product: { name: string; jan: string; maker: string | null }) {
  return `${product.name}（JAN ${product.jan} / メーカー${product.maker ?? '不明'}）`
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('ja-JP')
}

export function CompatList({ items, isAdmin, onDelete, hasFilter, isLoading, onAddClick }: CompatListProps) {
  if (isLoading) {
    return (
      <div data-testid="compat-list-skeleton" className="animate-pulse space-y-2 p-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 rounded" style={{ backgroundColor: '#F3F4F6' }} />
        ))}
      </div>
    )
  }

  if (items.length === 0) {
    if (hasFilter) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-sm font-medium" style={{ color: '#6B7280' }}>条件に一致する互換品がありません</p>
        </div>
      )
    }
    if (isAdmin) {
      return (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <p className="text-sm font-medium" style={{ color: '#6B7280' }}>互換品が登録されていません</p>
          <button
            type="button"
            onClick={onAddClick}
            className="mt-3 text-sm font-semibold"
            style={{ color: '#FF5F03' }}
          >
            ＋互換品を追加
          </button>
        </div>
      )
    }
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>互換品はまだ登録されていません</p>
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr style={{ backgroundColor: '#072C2C' }}>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              カテゴリ名
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              製品A
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              製品B
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              備考
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              登録日
            </th>
            {isAdmin && (
              <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
                操作
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((item, i) => (
            <tr
              key={item.id}
              className="transition-colors duration-100 hover:bg-[#EDEADE]/60"
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-6 py-4 text-sm" style={{ color: '#111827' }}>{item.categoryName}</td>
              <td className="px-6 py-4 text-sm" style={{ color: '#111827' }}>{formatProductLabel(item.product1)}</td>
              <td className="px-6 py-4 text-sm" style={{ color: '#111827' }}>{formatProductLabel(item.product2)}</td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>{item.note ?? '—'}</td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {formatDate(item.createdAt)}
              </td>
              {isAdmin && (
                <td className="px-6 py-4 text-sm">
                  <button
                    type="button"
                    onClick={() => {
                      const message = `【${formatProductLabel(item.product1)}】と【${formatProductLabel(item.product2)}】の互換登録を削除しますか？`
                      if (confirm(message)) {
                        onDelete(item.id)
                      }
                    }}
                    className="text-xs font-semibold uppercase tracking-wide px-3 py-1.5 transition-colors duration-100 focus:outline-none focus-visible:ring-2"
                    style={{ color: '#DC2626', backgroundColor: 'transparent', border: '1px solid #DC2626', borderRadius: '2px', fontFamily: 'var(--font-oswald), sans-serif' }}
                  >
                    削除
                  </button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
