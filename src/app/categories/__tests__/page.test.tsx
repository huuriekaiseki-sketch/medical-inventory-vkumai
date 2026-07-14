import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CategoriesPage from '../page'

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const categories = [
  { id: '1', name: '消耗品', description: 'メモ', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: '2', name: '医療機器', description: null, createdAt: '2026-02-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z' },
]

describe('CategoriesPage', () => {
  beforeEach(() => {
    push.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('GET /api/categories の結果を一覧表示する', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ categories }),
    } as Response)

    render(<CategoriesPage />)

    expect(await screen.findByText('消耗品')).toBeInTheDocument()
    expect(screen.getByText('医療機器')).toBeInTheDocument()
    expect(global.fetch).toHaveBeenCalledWith('/api/categories')
  })

  it('新規登録ボタンで /categories/new へ遷移する', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ categories }),
    } as Response)

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getByRole('button', { name: /新規登録/ }))
    expect(push).toHaveBeenCalledWith('/categories/new')
  })

  it('編集ボタンで /categories/:id/edit へ遷移する', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ categories }),
    } as Response)

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getAllByText('編集')[0])
    expect(push).toHaveBeenCalledWith('/categories/1/edit')
  })

  it('削除確認OKで DELETE を呼び再取得する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ categories }),
    } as Response)
    vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getAllByText('削除')[0])

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/categories/1', { method: 'DELETE' })
    })
  })

  it('削除確認キャンセルで DELETE を呼ばない', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ categories }),
    } as Response)
    vi.spyOn(window, 'confirm').mockReturnValue(false)

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getAllByText('削除')[0])
    expect(fetchMock).not.toHaveBeenCalledWith('/api/categories/1', { method: 'DELETE' })
  })

  it('削除が409使用中エラーのときバナーにメッセージを表示する', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchMock = vi.spyOn(global, 'fetch')
    // 初回 GET
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ categories }) } as Response)
    // DELETE -> 409
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: 'このカテゴリは使用中です' }) } as Response)
    // 再取得 GET
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ categories }) } as Response)

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getAllByText('削除')[0])

    expect(await screen.findByText('このカテゴリは使用中です')).toBeInTheDocument()
  })

  it('削除でfetchが例外を投げた場合もエラーバナーを表示する', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const fetchMock = vi.spyOn(global, 'fetch')
    // 初回 GET
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ categories }) } as Response)
    // DELETE -> ネットワーク例外
    fetchMock.mockRejectedValueOnce(new Error('network error'))

    render(<CategoriesPage />)
    await screen.findByText('消耗品')

    await userEvent.click(screen.getAllByText('削除')[0])

    expect(await screen.findByText('削除に失敗しました')).toBeInTheDocument()
  })
})
