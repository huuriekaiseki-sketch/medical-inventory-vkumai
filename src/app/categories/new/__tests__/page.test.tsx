import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import NewCategoryPage from '../page'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

describe('NewCategoryPage', () => {
  beforeEach(() => {
    push.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('フォーム送信で POST /api/categories を呼び一覧へ遷移する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ category: { id: '1' } }),
    } as Response)

    render(<NewCategoryPage />)

    await userEvent.type(screen.getByLabelText('カテゴリ名'), '消耗品')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/categories', expect.objectContaining({ method: 'POST' }))
      expect(push).toHaveBeenCalledWith('/categories')
    })
  })

  it('POST 失敗でエラーメッセージを表示し遷移しない', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: '登録に失敗しました' }),
    } as Response)

    render(<NewCategoryPage />)

    await userEvent.type(screen.getByLabelText('カテゴリ名'), '消耗品')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    expect(await screen.findByText('登録に失敗しました')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('ネットワークエラーでエラーメッセージを表示し遷移しない', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network error'))

    render(<NewCategoryPage />)

    await userEvent.type(screen.getByLabelText('カテゴリ名'), '消耗品')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    expect(await screen.findByText('network error')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('一覧に戻るリンクがある', () => {
    render(<NewCategoryPage />)
    const link = screen.getByRole('link', { name: /カテゴリ一覧に戻る/ })
    expect(link).toHaveAttribute('href', '/categories')
  })
})
