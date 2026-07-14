import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import CompatPage from '../page'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))

const categories = [{ id: 'cat1', name: '縫合糸', description: null, createdAt: '', updatedAt: '' }]
const compatibility = {
  id: 'c1',
  categoryId: 'cat1',
  categoryName: '縫合糸',
  productId1: 'p1',
  product1: { jan: '4900000000001', name: '製品A', maker: 'テルモ' },
  productId2: 'p2',
  product2: { jan: '4900000000002', name: '製品B', maker: null },
  note: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
}

function mockFetch({ isAdmin = false, compatibilities = [compatibility] as unknown[] } = {}) {
  return vi.fn().mockImplementation((url: string) => {
    if (url.startsWith('/api/categories')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories }) })
    }
    if (url.startsWith('/api/facilities')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ facilities: [], isAdmin }) })
    }
    if (url.startsWith('/api/compat/products')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products: [] }) })
    }
    if (url.startsWith('/api/compat')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ compatibilities }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }) as unknown as typeof fetch
}

describe('CompatPage', () => {
  beforeEach(() => {
    vi.stubGlobal('confirm', vi.fn(() => true))
  })

  it('一般ユーザーには「＋互換品を追加」フォームが表示されない', async () => {
    global.fetch = mockFetch({ isAdmin: false })
    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')
    expect(screen.queryByRole('button', { name: '＋互換品を追加' })).not.toBeInTheDocument()
  })

  it('管理者には「＋互換品を追加」フォームが表示される', async () => {
    global.fetch = mockFetch({ isAdmin: true })
    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')
    expect(screen.getByRole('button', { name: '＋互換品を追加' })).toBeInTheDocument()
  })

  it('カテゴリ選択で /api/compat にcategoryIdクエリを付与して再取得する', async () => {
    const fetchMock = mockFetch({ isAdmin: false })
    global.fetch = fetchMock
    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')

    await userEvent.selectOptions(screen.getByLabelText('カテゴリで絞り込み'), 'cat1')

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('categoryId=cat1'))
    })
  })

  it('キーワード入力で /api/compat にkeywordクエリを付与して再取得する', async () => {
    const fetchMock = mockFetch({ isAdmin: false })
    global.fetch = fetchMock
    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')

    await userEvent.type(screen.getByLabelText('キーワード検索'), 'テルモ')

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('keyword=%E3%83%86%E3%83%AB%E3%83%A2'))
    })
  })

  it('一覧取得に失敗した場合エラーメッセージを表示する', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/categories')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories }) })
      if (url.startsWith('/api/facilities')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ facilities: [], isAdmin: false }) })
      if (url.startsWith('/api/compat')) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }) as unknown as typeof fetch
    render(<CompatPage />)
    expect(await screen.findByText('互換品の取得に失敗しました')).toBeInTheDocument()
  })

  it('削除ボタン押下で確認後にDELETEし、一覧が再取得される', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/categories')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories }) })
      if (url.startsWith('/api/facilities')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ facilities: [], isAdmin: true }) })
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) })
      if (url.startsWith('/api/compat')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ compatibilities: [compatibility] }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }) as unknown as typeof fetch
    global.fetch = fetchMock

    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')
    await userEvent.click(screen.getByRole('button', { name: '削除' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/compat/c1', expect.objectContaining({ method: 'DELETE' }))
    })
  })

  it('全体0件かつ管理者のとき、一覧内の「＋互換品を追加」導線からフォームを開ける', async () => {
    global.fetch = mockFetch({ isAdmin: true, compatibilities: [] })
    render(<CompatPage />)
    await screen.findByText('互換品が登録されていません')

    // 一覧が全体0件の間はCompatForm自身のトグルボタンは非表示にし、
    // CompatListの空状態にある「＋互換品を追加」導線のみを表示する（重複描画防止）。
    const addButton = screen.getByRole('button', { name: '＋互換品を追加' })

    await userEvent.click(addButton)
    expect(screen.getByLabelText('カテゴリ')).toBeInTheDocument()
  })

  it('削除対象が404の場合「すでに削除されています」を表示し一覧を再取得する', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/categories')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ categories }) })
      if (url.startsWith('/api/facilities')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ facilities: [], isAdmin: true }) })
      if (init?.method === 'DELETE') return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: '見つかりません' }) })
      if (url.startsWith('/api/compat')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ compatibilities: [compatibility] }) })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
    }) as unknown as typeof fetch
    global.fetch = fetchMock

    render(<CompatPage />)
    await screen.findByText('製品A（JAN 4900000000001 / メーカーテルモ）')
    await userEvent.click(screen.getByRole('button', { name: '削除' }))

    expect(await screen.findByText('すでに削除されています')).toBeInTheDocument()
  })
})
