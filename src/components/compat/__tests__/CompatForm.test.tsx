import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CompatForm } from '../CompatForm'
import type { Category } from '@/types/category'

const categories: Category[] = [
  { id: 'cat1', name: '縫合糸', description: null, createdAt: '', updatedAt: '' },
  { id: 'cat2', name: 'カテーテル', description: null, createdAt: '', updatedAt: '' },
]

const products = [
  { id: 'p1', jan: '4900000000001', ref: 'R1', name: '製品A', maker: 'テルモ', createdAt: '', updatedAt: '' },
  { id: 'p2', jan: '4900000000002', ref: 'R2', name: '製品B', maker: null, createdAt: '', updatedAt: '' },
]

describe('CompatForm', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('「＋互換品を追加」ボタン押下でフォームが展開する', async () => {
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    expect(screen.queryByLabelText('カテゴリ')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    expect(screen.getByLabelText('カテゴリ')).toBeInTheDocument()
  })

  it('カテゴリ未選択時は製品A・Bのselectがdisabledでプレースホルダーを表示する', async () => {
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    expect(screen.getByLabelText('製品A')).toBeDisabled()
    expect(screen.getByLabelText('製品B')).toBeDisabled()
    expect(screen.getAllByText('先にカテゴリを選択してください').length).toBeGreaterThan(0)
  })

  it('カテゴリ選択で製品候補を取得し、取得中はスピナー表示&select disabled、完了後は選択可能になる', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation(() =>
      new Promise((resolve) => { resolveFetch = () => resolve({ ok: true, json: () => Promise.resolve({ products }) }) })
    )
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')

    expect(screen.getByTestId('compat-form-products-loading')).toBeInTheDocument()
    expect(screen.getByLabelText('製品A')).toBeDisabled()

    resolveFetch(null)
    await waitFor(() => expect(screen.queryByTestId('compat-form-products-loading')).not.toBeInTheDocument())
    expect(screen.getByLabelText('製品A')).not.toBeDisabled()
    expect(fetch).toHaveBeenCalledWith('/api/compat/products?categoryId=cat1')
  })

  it('選択肢ラベルは「{name}（JAN: {jan}、メーカー: {maker}）」形式', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: () => Promise.resolve({ products }) })
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')
    await waitFor(() => expect(screen.getByLabelText('製品A')).not.toBeDisabled())
    expect(screen.getAllByText('製品A（JAN: 4900000000001、メーカー: テルモ）').length).toBeGreaterThan(0)
    expect(screen.getAllByText('製品B（JAN: 4900000000002、メーカー: 不明）').length).toBeGreaterThan(0)
  })

  it('製品Aで選択済みの製品は製品Bの選択肢から除外される', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: () => Promise.resolve({ products }) })
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')
    await waitFor(() => expect(screen.getByLabelText('製品A')).not.toBeDisabled())
    await userEvent.selectOptions(screen.getByLabelText('製品A'), 'p1')

    const productBSelect = screen.getByLabelText('製品B') as HTMLSelectElement
    const optionValues = Array.from(productBSelect.options).map((o) => o.value)
    expect(optionValues).not.toContain('p1')
  })

  it('備考は最大500文字までのmaxLengthが設定されている', async () => {
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    expect(screen.getByLabelText('備考')).toHaveAttribute('maxLength', '500')
  })

  it('送信成功でPOSTし、フォームがクリアされonSuccessが呼ばれる', async () => {
    const onSuccess = vi.fn()
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ compatibility: {} }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products }) })
    })
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={onSuccess} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')
    await waitFor(() => expect(screen.getByLabelText('製品A')).not.toBeDisabled())
    await userEvent.selectOptions(screen.getByLabelText('製品A'), 'p1')
    await userEvent.selectOptions(screen.getByLabelText('製品B'), 'p2')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    await waitFor(() => expect(onSuccess).toHaveBeenCalled())
    expect(fetch).toHaveBeenCalledWith('/api/compat', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ categoryId: 'cat1', productId1: 'p1', productId2: 'p2', note: null }),
    }))
    // フォームが閉じてクリアされていること
    expect(screen.queryByLabelText('カテゴリ')).not.toBeInTheDocument()
  })

  it('重複エラー(409)時にエラーメッセージを表示する', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'すでに登録済みです。【製品A】と【製品B】は既に互換登録されています' }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products }) })
    })
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')
    await waitFor(() => expect(screen.getByLabelText('製品A')).not.toBeDisabled())
    await userEvent.selectOptions(screen.getByLabelText('製品A'), 'p1')
    await userEvent.selectOptions(screen.getByLabelText('製品B'), 'p2')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    expect(await screen.findByText(/すでに登録済みです。【製品A】と【製品B】は既に互換登録されています/)).toBeInTheDocument()
  })

  it('ネットワークエラー時にエラーメッセージを表示する', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.reject(new Error('network error'))
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ products }) })
    })
    render(<CompatForm categories={categories} isAdmin={true} onSuccess={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: '＋互換品を追加' }))
    await userEvent.selectOptions(screen.getByLabelText('カテゴリ'), 'cat1')
    await waitFor(() => expect(screen.getByLabelText('製品A')).not.toBeDisabled())
    await userEvent.selectOptions(screen.getByLabelText('製品A'), 'p1')
    await userEvent.selectOptions(screen.getByLabelText('製品B'), 'p2')
    await userEvent.click(screen.getByRole('button', { name: '登録' }))

    expect(await screen.findByText('登録に失敗しました')).toBeInTheDocument()
  })
})
