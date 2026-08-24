import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'

import AdminIndexPage from '../page'

// WHY: /admin直アクセス404の再発防止(issue #645)。インデックスページが
// admin配下の2機能への導線を持つことだけを検証する軽量テスト。
describe('AdminIndexPage', () => {
  it('ユーザー管理と発注金額レポートへのリンクを表示する', () => {
    render(<AdminIndexPage />)

    const usersLink = screen.getByRole('link', { name: 'ユーザー管理（招待・権限変更）' })
    expect(usersLink).toHaveAttribute('href', '/admin/users')

    const reportsLink = screen.getByRole('link', { name: '発注金額レポート' })
    expect(reportsLink).toHaveAttribute('href', '/admin/reports')
  })
})
