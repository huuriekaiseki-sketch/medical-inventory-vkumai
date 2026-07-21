import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DistributorProductSearchFilters } from '../DistributorProductSearchFilters'

const categories = [
  { id: 'c1', name: 'カテゴリA', description: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'c2', name: 'カテゴリB', description: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
]

describe('DistributorProductSearchFilters', () => {
  it('カテゴリ変更でonCategoryChangeが即時呼ばれる', async () => {
    const onCategoryChange = vi.fn()
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={onCategoryChange}
        onClear={vi.fn()}
      />
    )

    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'c1')
    expect(onCategoryChange).toHaveBeenCalledWith('c1')
  })

  it('全カテゴリが選択肢として表示され、デフォルトは「すべてのカテゴリ」value=""', () => {
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const select = screen.getByLabelText('カテゴリ') as HTMLSelectElement
    expect(select.value).toBe('')
    expect(screen.getByRole('option', { name: 'すべてのカテゴリ' })).toHaveValue('')
    expect(screen.getByRole('option', { name: 'カテゴリA' })).toHaveValue('c1')
    expect(screen.getByRole('option', { name: 'カテゴリB' })).toHaveValue('c2')
  })

  it('キーワードdebounceが300ms動作する', async () => {
    const onKeywordChange = vi.fn()
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={onKeywordChange}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    const input = screen.getByLabelText('キーワード')
    await userEvent.type(input, '商品A')
    expect(onKeywordChange).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(onKeywordChange).toHaveBeenCalledWith('商品A')
    })
  })

  it('クリアボタンでonClear', async () => {
    const onClear = vi.fn()
    render(
      <DistributorProductSearchFilters
        keyword="商品A"
        categoryId="c1"
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={onClear}
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'クリア' }))
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('categories === undefinedのとき「読み込み中…」表示でセレクタdisabled', () => {
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={undefined}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.getByText('読み込み中…')).toBeInTheDocument()
    expect(screen.getByLabelText('カテゴリ')).toBeDisabled()
  })

  it('categories === []のとき通常disabled表示（読み込み中表示ではない）', () => {
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={[]}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )

    expect(screen.queryByText('読み込み中…')).not.toBeInTheDocument()
    expect(screen.getByLabelText('カテゴリ')).toBeDisabled()
  })

  it('keyword prop変更時にテキストボックスが同期される', () => {
    const { rerender } = render(
      <DistributorProductSearchFilters
        keyword="商品A"
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('商品A')

    rerender(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveValue('')
  })

  it('isLoading=trueのとき、ローディング表示が出る', () => {
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={true}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByText('読み込み中...')).toBeInTheDocument()
  })

  it('キーワード入力欄にmaxLength=100が設定されている', () => {
    render(
      <DistributorProductSearchFilters
        keyword=""
        categoryId=""
        categories={categories}
        isLoading={false}
        onKeywordChange={vi.fn()}
        onCategoryChange={vi.fn()}
        onClear={vi.fn()}
      />
    )
    expect(screen.getByLabelText('キーワード')).toHaveAttribute('maxLength', '100')
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
        <DistributorProductSearchFilters
          keyword=""
          categoryId=""
          categories={categories}
          isLoading={false}
          onKeywordChange={onKeywordChange}
          onCategoryChange={vi.fn()}
          onClear={onClear}
        />
      )

      const input = screen.getByLabelText('キーワード')
      fireEvent.change(input, { target: { value: '商品A' } })
      fireEvent.click(screen.getByRole('button', { name: 'クリア' }))

      vi.advanceTimersByTime(300)

      expect(onClear).toHaveBeenCalledTimes(1)
      expect(onKeywordChange).not.toHaveBeenCalled()
    })
  })
})
