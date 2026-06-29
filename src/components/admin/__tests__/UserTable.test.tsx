import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UserTable } from '../UserTable'
import type { AdminUser } from '@/types/admin'

const facilities = [
  { id: 'f1', name: '中央病院' },
  { id: 'f2', name: '東クリニック' },
]
const users: AdminUser[] = [
  { id: 'u1', email: 'a@test.com', lastSignInAt: '2026-06-27T00:00:00Z', facilityIds: ['f1'] },
]

describe('UserTable', () => {
  it('ユーザーのメールが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    expect(screen.getByText('a@test.com')).toBeInTheDocument()
  })

  it('展開ボタンをクリックすると施設チェックボックスが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    expect(screen.getByLabelText('中央病院')).toBeInTheDocument()
    expect(screen.getByLabelText('東クリニック')).toBeInTheDocument()
  })

  it('担当施設のチェックボックスは checked になっている', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    expect(screen.getByLabelText('中央病院')).toBeChecked()
    expect(screen.getByLabelText('東クリニック')).not.toBeChecked()
  })

  it('チェックボックスを変更すると onToggleFacility が呼ばれる', () => {
    const onToggle = vi.fn()
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={onToggle}
        onDeleteUser={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    fireEvent.click(screen.getByLabelText('東クリニック'))
    expect(onToggle).toHaveBeenCalledWith('u1', 'f2', true)
  })
})
