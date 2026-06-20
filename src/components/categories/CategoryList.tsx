'use client'

import type { Category } from '@/types/category'

type CategoryListProps = {
  categories: Category[]
  onEdit: (id: string) => void
  onDelete: (id: string) => void
}

export function CategoryList({ categories, onEdit, onDelete }: CategoryListProps) {
  if (categories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium" style={{ color: '#6B7280' }}>カテゴリが登録されていません</p>
        <p className="mt-1 text-xs" style={{ color: '#9CA3AF' }}>「新規登録」から追加してください</p>
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
              説明
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              登録日
            </th>
            <th className="px-6 py-3 text-left text-xs font-semibold uppercase tracking-widest text-white/80" style={{ fontFamily: 'var(--font-oswald), sans-serif' }}>
              操作
            </th>
          </tr>
        </thead>
        <tbody>
          {categories.map((category, i) => (
            <tr
              key={category.id}
              className="transition-colors duration-100 hover:bg-[#EDEADE]/60"
              style={{ borderBottom: '1px solid #E5E7EB', backgroundColor: i % 2 === 0 ? '#fff' : '#F9FAFB' }}
            >
              <td className="px-6 py-4 text-sm font-medium" style={{ color: '#111827' }}>
                {category.name}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280' }}>
                {category.description ?? '—'}
              </td>
              <td className="px-6 py-4 text-sm" style={{ color: '#6B7280', fontFamily: 'var(--font-ubuntu-mono), monospace' }}>
                {new Date(category.createdAt).toLocaleDateString('ja-JP')}
              </td>
              <td className="px-6 py-4 text-sm">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => onEdit(category.id)}
                    className="text-xs font-semibold uppercase tracking-wide px-3 py-1.5 transition-colors duration-100 focus:outline-none focus-visible:ring-2"
                    style={{ color: '#072C2C', border: '1px solid #072C2C', borderRadius: '2px', fontFamily: 'var(--font-oswald), sans-serif' }}
                    onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = '#072C2C'; (e.target as HTMLElement).style.color = '#fff' }}
                    onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = 'transparent'; (e.target as HTMLElement).style.color = '#072C2C' }}
                  >
                    編集
                  </button>
                  <button
                    onClick={() => onDelete(category.id)}
                    className="text-xs font-semibold uppercase tracking-wide px-3 py-1.5 transition-colors duration-100 focus:outline-none focus-visible:ring-2"
                    style={{ color: '#DC2626', border: '1px solid #DC2626', borderRadius: '2px', fontFamily: 'var(--font-oswald), sans-serif' }}
                    onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = '#DC2626'; (e.target as HTMLElement).style.color = '#fff' }}
                    onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = 'transparent'; (e.target as HTMLElement).style.color = '#DC2626' }}
                  >
                    削除
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
