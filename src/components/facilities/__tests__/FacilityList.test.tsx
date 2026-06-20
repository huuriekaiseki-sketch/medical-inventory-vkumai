import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FacilityList } from '../FacilityList'
import type { Facility } from '@/types/facility'

const facilities: Facility[] = [
  { id: '1', name: '中央病院', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: '2', name: '東クリニック', createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
]

describe('FacilityList', () => {
  it('施設一覧が表示される', () => {
    render(<FacilityList facilities={facilities} />)
    expect(screen.getByText('中央病院')).toBeInTheDocument()
    expect(screen.getByText('東クリニック')).toBeInTheDocument()
  })

  it('空のとき「施設が登録されていません」が表示される', () => {
    render(<FacilityList facilities={[]} />)
    expect(screen.getByText('施設が登録されていません')).toBeInTheDocument()
  })
})
