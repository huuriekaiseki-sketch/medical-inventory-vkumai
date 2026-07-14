import { Suspense } from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import EditProductPage from '../page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

afterEach(() => {
  vi.restoreAllMocks()
})

async function renderPage(p: Promise<{ id: string }>) {
  await act(async () => {
    render(
      <Suspense fallback={null}>
        <EditProductPage params={p} />
      </Suspense>,
    )
  })
}

describe('EditProductPage', () => {
  it('編集画面を開いたとき製品名・メーカー名が初期値として表示される', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          product: {
            id: '1',
            jan: '4900000000001',
            ref: 'REF-1',
            name: 'カテーテルAB型',
            maker: 'テルモ',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        }),
    }) as unknown as typeof fetch

    await renderPage(Promise.resolve({ id: '1' }))

    await waitFor(() => {
      expect(screen.getByLabelText('製品名')).toHaveValue('カテーテルAB型')
    })
    expect(screen.getByLabelText('メーカー名')).toHaveValue('テルモ')
    expect(screen.getByLabelText('JAN コード')).toHaveValue('4900000000001')
    expect(screen.getByLabelText('REF コード')).toHaveValue('REF-1')
  })

  it('更新時にネットワークエラーが発生した場合エラーメッセージを表示する', async () => {
    const alertMock = vi.spyOn(window, 'alert').mockImplementation(() => {})
    global.fetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            product: {
              id: '1',
              jan: '4900000000001',
              ref: 'REF-1',
              name: 'カテーテルAB型',
              maker: 'テルモ',
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            },
          }),
      })
      .mockRejectedValueOnce(new Error('network error')) as unknown as typeof fetch

    await renderPage(Promise.resolve({ id: '1' }))

    await waitFor(() => {
      expect(screen.getByLabelText('製品名')).toHaveValue('カテーテルAB型')
    })

    await userEvent.click(screen.getByRole('button', { name: '更新' }))

    await waitFor(() => {
      expect(alertMock).toHaveBeenCalledWith('network error')
    })
  })
})
