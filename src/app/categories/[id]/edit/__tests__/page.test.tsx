import { Suspense } from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditCategoryPage from '../page'

async function renderPage(p: Promise<{ id: string }>) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <EditCategoryPage params={p} />
      </Suspense>,
    )
  })
}

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

const category = {
  id: '1',
  name: '消耗品',
  description: 'メモ',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
}

const params = Promise.resolve({ id: '1' })

describe('EditCategoryPage', () => {
  beforeEach(() => {
    push.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('既存値を読み込みフォームに反映する', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ category }),
    } as Response)

    await renderPage(params)

    await waitFor(() => {
      expect(screen.getByLabelText('カテゴリ名')).toHaveValue('消耗品')
    })
    expect(screen.getByLabelText('説明')).toHaveValue('メモ')
  })

  it('送信で PUT /api/categories/:id を呼び一覧へ遷移する', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockImplementation(async (url, init) => {
      if (init?.method === 'PUT') {
        return { ok: true, json: async () => ({ category }) } as Response
      }
      return { ok: true, json: async () => ({ category }) } as Response
    })

    await renderPage(params)
    await waitFor(() => {
      expect(screen.getByLabelText('カテゴリ名')).toHaveValue('消耗品')
    })

    await userEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/categories/1', expect.objectContaining({ method: 'PUT' }))
      expect(push).toHaveBeenCalledWith('/categories')
    })
  })

  it('更新時のネットワークエラーでエラーメッセージを表示し遷移しない', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ category }) } as Response)
    fetchMock.mockRejectedValueOnce(new Error('network error'))

    await renderPage(params)
    await waitFor(() => {
      expect(screen.getByLabelText('カテゴリ名')).toHaveValue('消耗品')
    })

    await userEvent.click(screen.getByRole('button', { name: '更新' }))

    expect(await screen.findByText('network error')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('取得失敗でエラーメッセージを表示する', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network'))

    await renderPage(params)

    expect(await screen.findByText('カテゴリの取得に失敗しました')).toBeInTheDocument()
  })

  it('PUT 失敗でエラーメッセージを表示し遷移しない', async () => {
    const fetchMock = vi.spyOn(global, 'fetch')
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ category }) } as Response)
    fetchMock.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: '更新に失敗しました' }) } as Response)

    await renderPage(params)
    await waitFor(() => {
      expect(screen.getByLabelText('カテゴリ名')).toHaveValue('消耗品')
    })

    await userEvent.click(screen.getByRole('button', { name: '更新' }))

    expect(await screen.findByText('更新に失敗しました')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('一覧に戻るリンクがある', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({ ok: true, json: async () => ({ category }) } as Response)
    await renderPage(params)
    await waitFor(() => {
      expect(screen.getByLabelText('カテゴリ名')).toHaveValue('消耗品')
    })
    const link = screen.getByRole('link', { name: /カテゴリ一覧に戻る/ })
    expect(link).toHaveAttribute('href', '/categories')
  })
})
