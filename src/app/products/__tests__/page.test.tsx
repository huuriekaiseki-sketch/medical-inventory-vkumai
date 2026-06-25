import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProductsPage from '../page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))

describe('ProductsPage handleDelete', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true))
    vi.stubGlobal('alert', vi.fn())
  })

  it('削除はDELETEの完了(await)を待ってから再取得する', async () => {
    const calls: string[] = []
    let resolveDelete: (v: unknown) => void = () => {}
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        calls.push('delete-start')
        return new Promise((resolve) => {
          resolveDelete = () => {
            calls.push('delete-end')
            resolve({ ok: true, json: () => Promise.resolve({}) })
          }
        })
      }
      calls.push('list')
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1' }] }) })
    }) as unknown as typeof fetch

    render(<ProductsPage />)
    await screen.findByText('4900000000001')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])
    // DELETE開始済み・終了前なので再取得(list)はまだ起きていない
    expect(calls).toContain('delete-start')
    expect(calls.filter((c) => c === 'list')).toHaveLength(1)

    resolveDelete(null)
    await waitFor(() => expect(calls.filter((c) => c === 'list')).toHaveLength(2))
    expect(calls.indexOf('delete-end')).toBeLessThan(calls.lastIndexOf('list'))
  })
})
