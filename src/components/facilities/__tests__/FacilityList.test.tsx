import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { FacilityList } from '../FacilityList'
import type { Facility } from '@/types/facility'

const facilities: Facility[] = [
  { id: '1', name: '中央病院', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: '2', name: '東クリニック', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
]

describe('FacilityList', () => {
  it('施設一覧が表示される', () => {
    render(<FacilityList facilities={facilities} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('中央病院')).toBeInTheDocument()
    expect(screen.getByText('東クリニック')).toBeInTheDocument()
  })

  it('空のとき「施設が登録されていません」が表示される', () => {
    render(<FacilityList facilities={[]} onEdit={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByText('施設が登録されていません')).toBeInTheDocument()
  })

  it('編集ボタンクリックで onEdit が呼ばれる', async () => {
    const onEdit = vi.fn()
    render(<FacilityList facilities={facilities} onEdit={onEdit} onDelete={vi.fn()} />)
    await userEvent.click(screen.getAllByText('編集')[0])
    expect(onEdit).toHaveBeenCalledWith('1')
  })

  it('削除ボタンクリックで onDelete が呼ばれる', async () => {
    const onDelete = vi.fn()
    render(<FacilityList facilities={facilities} onEdit={vi.fn()} onDelete={onDelete} />)
    await userEvent.click(screen.getAllByText('削除')[0])
    expect(onDelete).toHaveBeenCalledWith('1')
  })
})
