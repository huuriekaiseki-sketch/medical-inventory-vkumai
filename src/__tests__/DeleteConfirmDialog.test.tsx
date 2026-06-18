import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DeleteConfirmDialog } from '@/components/products/DeleteConfirmDialog'

describe('DeleteConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    productName: 'テスト製品A',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  }

  it('isOpen=false のとき何も表示されない', () => {
    const { container } = render(
      <DeleteConfirmDialog {...defaultProps} isOpen={false} />
    )
    expect(container.innerHTML).toBe('')
  })

  it('isOpen=true のとき製品名を含むメッセージが表示される', () => {
    render(<DeleteConfirmDialog {...defaultProps} />)
    expect(
      screen.getByText('テスト製品A を削除しますか？')
    ).toBeInTheDocument()
  })

  it('「削除」ボタンクリックで onConfirm が呼ばれる', async () => {
    const onConfirm = vi.fn()
    render(<DeleteConfirmDialog {...defaultProps} onConfirm={onConfirm} />)
    await userEvent.click(screen.getByRole('button', { name: '削除' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('「キャンセル」ボタンクリックで onCancel が呼ばれる', async () => {
    const onCancel = vi.fn()
    render(<DeleteConfirmDialog {...defaultProps} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'キャンセル' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })
})
