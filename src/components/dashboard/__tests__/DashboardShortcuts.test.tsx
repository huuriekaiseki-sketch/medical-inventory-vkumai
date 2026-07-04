import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DashboardShortcuts } from '../DashboardShortcuts'

describe('DashboardShortcuts', () => {
  it('管理ページへのショートカットリンクが表示される', () => {
    render(<DashboardShortcuts isAdmin={false} />)
    expect(screen.getByRole('link', { name: '施設一覧' })).toHaveAttribute('href', '/facilities')
    expect(screen.getByRole('link', { name: '商品一覧' })).toHaveAttribute('href', '/products')
    expect(screen.getByRole('link', { name: /販売店商品一覧/ })).toHaveAttribute('href', '/distributor-products')
    expect(screen.getByRole('link', { name: /病院価格一覧/ })).toHaveAttribute('href', '/hospital-prices')
    expect(screen.getByRole('link', { name: /カテゴリ一覧/ })).toHaveAttribute('href', '/categories')
  })

  it('admin権限がない場合は管理ユーザーページへのリンクが表示されない', () => {
    render(<DashboardShortcuts isAdmin={false} />)
    expect(screen.queryByRole('link', { name: /管理ユーザー/ })).not.toBeInTheDocument()
  })

  it('admin権限がある場合は管理ユーザーページへのリンクが表示される', () => {
    render(<DashboardShortcuts isAdmin={true} />)
    expect(screen.getByRole('link', { name: /管理ユーザー/ })).toHaveAttribute('href', '/admin/users')
  })
})
