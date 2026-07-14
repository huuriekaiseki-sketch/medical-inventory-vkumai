import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrderHistoryFilters } from '../OrderHistoryFilters'
import type { Facility } from '@/types/facility'

const facilities: Facility[] = [
  { id: 'f1', name: 'テスト施設A', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'f2', name: 'テスト施設B', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

function setup(overrides: Partial<React.ComponentProps<typeof OrderHistoryFilters>> = {}) {
  const props: React.ComponentProps<typeof OrderHistoryFilters> = {
    dateFrom: '',
    dateTo: '',
    productSearch: '',
    selectedKinds: ['case', 'consumable', 'loan', 'loan_return'],
    onDateFromChange: vi.fn(),
    onDateToChange: vi.fn(),
    onProductSearchChange: vi.fn(),
    onKindsChange: vi.fn(),
    onSearchSubmit: vi.fn(),
    showFacilitySelect: false,
    facilityOptions: [],
    selectedFacilityId: '',
    onFacilityChange: vi.fn(),
    allowEmptyFacility: false,
    ...overrides,
  }
  render(<OrderHistoryFilters {...props} />)
  return props
}

describe('OrderHistoryFilters', () => {
  it('4種別のチェックボックスがデフォルト全選択で表示される', () => {
    setup()
    expect(screen.getByRole('checkbox', { name: '症例発注' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '消耗品発注' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '短貸発注' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: '短貸返却' })).toBeChecked()
  })

  it('チェックボックスを外すとonKindsChangeが呼ばれ、選択が更新される', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.click(screen.getByRole('checkbox', { name: '症例発注' }))
    expect(props.onKindsChange).toHaveBeenCalledWith(['consumable', 'loan', 'loan_return'])
  })

  it('全チェックが外れた状態でも一つ再選択するとonKindsChangeが正しく呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup({ selectedKinds: [] })
    await user.click(screen.getByRole('checkbox', { name: '短貸発注' }))
    expect(props.onKindsChange).toHaveBeenCalledWith(['loan'])
  })

  it('showFacilitySelect=falseの場合、施設ドロップダウンを表示しない', () => {
    setup({ showFacilitySelect: false })
    expect(screen.queryByRole('combobox', { name: '施設' })).not.toBeInTheDocument()
  })

  it('showFacilitySelect=trueの場合、施設ドロップダウンを表示する', () => {
    setup({ showFacilitySelect: true, facilityOptions: facilities, selectedFacilityId: 'f1' })
    const select = screen.getByRole('combobox', { name: '施設' })
    expect(select).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'テスト施設A' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'テスト施設B' })).toBeInTheDocument()
  })

  it('allowEmptyFacility=trueの場合、「全施設」オプションが先頭に追加される', () => {
    setup({
      showFacilitySelect: true,
      facilityOptions: facilities,
      selectedFacilityId: '',
      allowEmptyFacility: true,
    })
    expect(screen.getByRole('option', { name: '全施設' })).toBeInTheDocument()
  })

  it('allowEmptyFacility=falseの場合、「全施設」オプションを追加しない', () => {
    setup({
      showFacilitySelect: true,
      facilityOptions: facilities,
      selectedFacilityId: 'f1',
      allowEmptyFacility: false,
    })
    expect(screen.queryByRole('option', { name: '全施設' })).not.toBeInTheDocument()
  })

  it('施設ドロップダウンを変更するとonFacilityChangeが呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup({ showFacilitySelect: true, facilityOptions: facilities, selectedFacilityId: 'f1' })
    await user.selectOptions(screen.getByRole('combobox', { name: '施設' }), 'f2')
    expect(props.onFacilityChange).toHaveBeenCalledWith('f2')
  })

  it('期間入力を変更するとonDateFromChange/onDateToChangeが呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup()
    const from = screen.getByLabelText('期間（開始）')
    await user.type(from, '2026-07-01')
    expect(props.onDateFromChange).toHaveBeenCalled()
  })

  it('製品名検索フォームを送信するとonSearchSubmitが呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup({ productSearch: 'テスト製品' })
    await user.click(screen.getByRole('button', { name: '検索' }))
    expect(props.onSearchSubmit).toHaveBeenCalled()
  })

  it('製品名入力を変更するとonProductSearchChangeが呼ばれる', async () => {
    const user = userEvent.setup()
    const props = setup()
    await user.type(screen.getByLabelText('製品名'), 'x')
    expect(props.onProductSearchChange).toHaveBeenCalled()
  })
})
