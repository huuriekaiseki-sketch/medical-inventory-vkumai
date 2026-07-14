import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OrderHistoryFilters } from '../OrderHistoryFilters'

describe('OrderHistoryFilters', () => {
  it('dateFrom/dateTo/keywordの現在値を表示する', () => {
    render(
      <OrderHistoryFilters
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        keyword="ガーゼ"
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByLabelText('開始日')).toHaveValue('2026-07-01')
    expect(screen.getByLabelText('終了日')).toHaveValue('2026-07-31')
    expect(screen.getByLabelText('キーワード')).toHaveValue('ガーゼ')
  })

  it('開始日を変更するとonDateFromChangeが呼ばれる', async () => {
    const onDateFromChange = vi.fn()
    render(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword=""
        onDateFromChange={onDateFromChange}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('開始日')
    fireEvent.change(input, { target: { value: '2026-07-01' } })
    expect(onDateFromChange).toHaveBeenCalledWith('2026-07-01')
  })

  it('終了日を変更するとonDateToChangeが呼ばれる', async () => {
    const onDateToChange = vi.fn()
    render(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword=""
        onDateFromChange={vi.fn()}
        onDateToChange={onDateToChange}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('終了日')
    fireEvent.change(input, { target: { value: '2026-07-31' } })
    expect(onDateToChange).toHaveBeenCalledWith('2026-07-31')
  })

  // WHY: キーワード入力は1文字ごとにonKeywordChangeを呼ぶと、親側のURL更新・API再取得が
  //      入力のたびに走ってしまう（issue #20 レビュー指摘: 正しさ minor, debounce欠如）。
  //      debounce後に呼ばれることをwaitForで検証する（入力直後は呼ばれないことも確認する）
  it('キーワードを入力するとdebounce後にonKeywordChangeが呼ばれる', async () => {
    const onKeywordChange = vi.fn()
    render(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword=""
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={onKeywordChange}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('キーワード')
    fireEvent.change(input, { target: { value: 'ガーゼ' } })
    expect(onKeywordChange).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(onKeywordChange).toHaveBeenCalledWith('ガーゼ')
    })
    expect(onKeywordChange).toHaveBeenCalledTimes(1)
  })

  it('入力欄の見た目の値はdebounce前でも即座に更新される', async () => {
    render(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword=""
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, 'ガーゼ')
    expect(input).toHaveValue('ガーゼ')
  })

  it('外部からkeywordプロップが変わると入力欄の表示に反映される（クリア時など）', () => {
    const { rerender } = render(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword="ガーゼ"
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('ガーゼ')

    rerender(
      <OrderHistoryFilters
        dateFrom=""
        dateTo=""
        keyword=""
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('')
  })

  it('クリアボタンを押すとonClearが呼ばれる', async () => {
    const onClear = vi.fn()
    render(
      <OrderHistoryFilters
        dateFrom="2026-07-01"
        dateTo="2026-07-31"
        keyword="ガーゼ"
        onDateFromChange={vi.fn()}
        onDateToChange={vi.fn()}
        onKeywordChange={vi.fn()}
        onClear={onClear}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })
})
