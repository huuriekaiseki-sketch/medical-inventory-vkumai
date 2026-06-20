import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock }),
}))

import NewDistributorProductPage from '../page'

const products = [{ id: 'p1', jan: '4900000000001', ref: 'REF-1', createdAt: '', updatedAt: '' }]
const categories = [
  { id: 'c1', name: 'カテゴリA', description: null, createdAt: '', updatedAt: '' },
]

beforeEach(() => {
  pushMock.mockReset()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setupFetch(postOk = true, postStatus = 200) {
  return vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return Promise.resolve({ ok: postOk, status: postStatus, json: () => Promise.resolve({ error: '登録に失敗しました' }) })
    }
    if (url === '/api/products') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ products }) })
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ categories }) })
  })
}

async function fillForm() {
  await userEvent.selectOptions(screen.getByLabelText('商品（JAN / REF）'), 'p1')
  await userEvent.type(screen.getByLabelText('メーカー'), 'メーカーA')
  await userEvent.type(screen.getByLabelText('仕入先'), '仕入先A')
  await userEvent.type(screen.getByLabelText('商品名'), '商品A')
  await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'c1')
  await userEvent.type(screen.getByLabelText('入数'), '10')
}

describe('NewDistributorProductPage', () => {
  it('products と categories を取得しフォームを表示する', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<NewDistributorProductPage />)
    expect(await screen.findByText('カテゴリA')).toBeInTheDocument()
    expect(screen.getByText('4900000000001 / REF-1')).toBeInTheDocument()
  })

  it('送信成功で一覧へ遷移する', async () => {
    global.fetch = setupFetch(true) as unknown as typeof fetch
    render(<NewDistributorProductPage />)
    await screen.findByText('カテゴリA')
    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: '登録' }))
    expect(pushMock).toHaveBeenCalledWith('/distributor-products')
  })

  it('送信失敗で submitError を表示する', async () => {
    global.fetch = setupFetch(false, 500) as unknown as typeof fetch
    render(<NewDistributorProductPage />)
    await screen.findByText('カテゴリA')
    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: '登録' }))
    expect(await screen.findByText('登録に失敗しました')).toBeInTheDocument()
    expect(pushMock).not.toHaveBeenCalled()
  })
})
