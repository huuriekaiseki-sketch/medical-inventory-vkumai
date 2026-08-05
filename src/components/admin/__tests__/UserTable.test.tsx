import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { UserTable } from '../UserTable'
import type { AdminUser, Facility } from '@/types/admin'

const facilities: Facility[] = [
  { id: 'f1', name: '中央病院', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: '東クリニック', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]
const users: AdminUser[] = [
  {
    id: 'u1',
    email: 'a@test.com',
    lastSignInAt: '2026-06-27T00:00:00Z',
    facilities: [{ id: 'f1', role: 'staff' }],
  },
]

describe('UserTable', () => {
  it('ユーザーのメールが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
        onChangeRole={vi.fn()}
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
        onChangeRole={vi.fn()}
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
        onChangeRole={vi.fn()}
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
        onChangeRole={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    fireEvent.click(screen.getByLabelText('東クリニック'))
    expect(onToggle).toHaveBeenCalledWith('u1', 'f2', true)
  })

  it('割り当て済み施設にはroleセレクトボックスが表示される', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
        onChangeRole={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    // f1 は割り当て済みなのでセレクトボックスが存在する
    const select = screen.getByLabelText('中央病院のrole')
    expect(select).toBeInTheDocument()
    expect((select as HTMLSelectElement).value).toBe('staff')
  })

  it('未割り当て施設にはroleセレクトボックスが表示されない', () => {
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
        onChangeRole={vi.fn()}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    // f2 は未割り当てなのでセレクトボックスは存在しない
    expect(screen.queryByLabelText('東クリニックのrole')).not.toBeInTheDocument()
  })

  it('roleセレクトボックスを変更すると onChangeRole が呼ばれる', () => {
    const onChangeRole = vi.fn()
    render(
      <UserTable
        users={users}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
        onChangeRole={onChangeRole}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    const select = screen.getByLabelText('中央病院のrole')
    fireEvent.change(select, { target: { value: 'admin' } })
    expect(onChangeRole).toHaveBeenCalledWith('u1', 'f1', 'admin')
  })

  it('viewerロールが正しく選択表示され、viewerへの変更もonChangeRoleに伝わる', () => {
    const viewerUsers: AdminUser[] = [
      {
        id: 'u2',
        email: 'viewer@test.com',
        lastSignInAt: null,
        facilities: [{ id: 'f1', role: 'viewer' }],
      },
    ]
    const onChangeRole = vi.fn()
    render(
      <UserTable
        users={viewerUsers}
        facilities={facilities}
        onToggleFacility={vi.fn()}
        onDeleteUser={vi.fn()}
        onChangeRole={onChangeRole}
      />
    )
    fireEvent.click(screen.getByText('▼ 展開して設定'))
    const select = screen.getByLabelText('中央病院のrole') as HTMLSelectElement
    // viewerロールのユーザーがstaffとして誤表示されない(issue #609)
    expect(select.value).toBe('viewer')

    fireEvent.change(select, { target: { value: 'viewer' } })
    expect(onChangeRole).toHaveBeenCalledWith('u2', 'f1', 'viewer')
  })
})
