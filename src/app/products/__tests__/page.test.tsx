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

  it('一覧取得が失敗した場合はエラーメッセージを表示する（catch漏れ防止）', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network error')) as unknown as typeof fetch

    render(<ProductsPage />)

    await screen.findByText('デバイスの取得に失敗しました')
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

  it('一覧取得(GET)が失敗した場合、エラーバナーを表示する', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }) as unknown as typeof fetch

    render(<ProductsPage />)

    expect(await screen.findByText('デバイスの取得に失敗しました')).toBeInTheDocument()
  })

  it('削除(DELETE)がネットワーク例外を投げた場合、alertでユーザーに通知する', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.reject(new Error('network error'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [{ id: '1', jan: '4900000000001', ref: 'R1' }] }) })
    }) as unknown as typeof fetch

    render(<ProductsPage />)
    await screen.findByText('4900000000001')

    await userEvent.click(screen.getAllByRole('button', { name: '削除' })[0])

    await waitFor(() => expect(global.alert).toHaveBeenCalledWith('削除に失敗しました'))
  })
})
