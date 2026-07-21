import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProductSearchFilters } from '../ProductSearchFilters'

// WHY: SPEC.md Part2 Set E-1 のテスト観点をそのままケース化する。
//      OrderHistoryFilters.test.tsx のdebounceテストパターン（fireEvent + waitFor）を踏襲する

describe('ProductSearchFilters', () => {
  it('キーワード入力後300ms以内はonKeywordChangeが呼ばれない', async () => {
    const onKeywordChange = vi.fn()
    render(
      <ProductSearchFilters
        keyword=""
        isLoading={false}
        onKeywordChange={onKeywordChange}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, 'カテーテル')
    expect(onKeywordChange).not.toHaveBeenCalled()
  })

  it('300ms後にonKeywordChangeが値付きで呼ばれる', async () => {
    const onKeywordChange = vi.fn()
    render(
      <ProductSearchFilters
        keyword=""
        isLoading={false}
        onKeywordChange={onKeywordChange}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, 'カテーテル')

    await waitFor(() => {
      expect(onKeywordChange).toHaveBeenCalledWith('カテーテル')
    })
  })

  it('クリアボタンクリックでonClearが呼ばれる', async () => {
    const onClear = vi.fn()
    render(
      <ProductSearchFilters
        keyword="カテーテル"
        isLoading={false}
        onKeywordChange={vi.fn()}
        onClear={onClear}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('keyword prop変更時にテキストボックスが同期される（外部クリア対応）', () => {
    const { rerender } = render(
      <ProductSearchFilters
        keyword="カテーテル"
        isLoading={false}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('カテーテル')

    rerender(
      <ProductSearchFilters
        keyword=""
        isLoading={false}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('')
  })

  it('isLoading=trueのとき、ローディング表示が出る（前回入力値は保持される）', () => {
    render(
      <ProductSearchFilters
        keyword="カテーテル"
        isLoading={true}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
    expect(screen.getByLabelText('キーワード')).toHaveValue('カテーテル')
  })

  it('キーワード入力欄にmaxLength=100が設定されている', () => {
    render(
      <ProductSearchFilters
        keyword=""
        isLoading={false}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveAttribute('maxLength', '100')
  })

  it('キーワード入力欄のidはproduct-keyword', () => {
    render(
      <ProductSearchFilters
        keyword=""
        isLoading={false}
        onKeywordChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveAttribute('id', 'product-keyword')
  })

  // WHY: レビュー指摘（正しさ important）。入力直後300ms以内にクリアすると、内部debounce
  //      タイマーがキャンセルされずに残り、クリア後にタイマーが発火してonKeywordChangeが
  //      古い値で呼ばれ、キーワードが復活してしまう競合状態があった
  describe('入力直後にクリアした場合の競合状態', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('debounceタイマー発火後もonKeywordChangeが呼ばれない（キーワードが復活しない）', () => {
      vi.useFakeTimers()
      const onKeywordChange = vi.fn()
      const onClear = vi.fn()
      render(
        <ProductSearchFilters
          keyword=""
          isLoading={false}
          onKeywordChange={onKeywordChange}
          onClear={onClear}
        />
      )

      const input = screen.getByLabelText('キーワード')
      fireEvent.change(input, { target: { value: 'カテーテル' } })
      fireEvent.click(screen.getByRole('button', { name: 'クリア' }))

      vi.advanceTimersByTime(300)

      expect(onClear).toHaveBeenCalledTimes(1)
      expect(onKeywordChange).not.toHaveBeenCalled()
    })
  })
})
