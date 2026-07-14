'use client'

import Link from 'next/link'

type DashboardShortcutsProps = {
  isAdmin: boolean
}

const BASE_SHORTCUTS = [
  { href: '/orders', label: '発注履歴' },
  { href: '/facilities', label: '施設一覧' },
  { href: '/products', label: '商品一覧' },
  { href: '/distributor-products', label: '販売店商品一覧' },
  { href: '/hospital-prices', label: '病院価格一覧' },
  { href: '/categories', label: 'カテゴリ一覧' },
]

const ADMIN_SHORTCUT = { href: '/admin/users', label: '管理ユーザー' }

export function DashboardShortcuts({ isAdmin }: DashboardShortcutsProps) {
  const shortcuts = isAdmin ? [...BASE_SHORTCUTS, ADMIN_SHORTCUT] : BASE_SHORTCUTS

  return (
    <div className="flex flex-wrap gap-3">
      {shortcuts.map((shortcut) => (
        <Link
          key={shortcut.href}
          href={shortcut.href}
          className="px-5 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
          style={{ backgroundColor: '#FF5F03', fontFamily: 'var(--font-ubuntu), sans-serif', borderRadius: '2px' }}
        >
          {shortcut.label}
        </Link>
      ))}
    </div>
  )
}
