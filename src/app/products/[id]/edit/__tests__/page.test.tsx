import { Suspense } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import EditProductPage from '../page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

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
})
