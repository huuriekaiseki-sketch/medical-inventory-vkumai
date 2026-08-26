import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsumableRegisterForm } from '../ConsumableRegisterForm'

describe('ConsumableRegisterForm', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  it('品名が未入力のまま送信するとAPIを呼ばずエラーを表示する', async () => {
    const onRegistered = vi.fn()
    render(<ConsumableRegisterForm facilityId="f-1" onRegistered={onRegistered} />)
    await userEvent.type(screen.getByLabelText('用途'), '止血')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))
    expect(await screen.findByText('品名を入力してください')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
    expect(onRegistered).not.toHaveBeenCalled()
  })

  it('品名が空白のみの場合もエラーを表示する', async () => {
    render(<ConsumableRegisterForm facilityId="f-1" onRegistered={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('品名'), '   ')
    await userEvent.type(screen.getByLabelText('用途'), '止血')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))
    expect(await screen.findByText('品名を入力してください')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('用途が未入力のまま送信するとAPIを呼ばずエラーを表示する', async () => {
    render(<ConsumableRegisterForm facilityId="f-1" onRegistered={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('品名'), 'ガーゼ')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))
    expect(await screen.findByText('用途を入力してください')).toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('必須項目を入力して送信するとPOSTが呼ばれ、成功時にonRegisteredが呼ばれフォームがリセットされる', async () => {
    const created = { id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '490000001', purpose: '止血', createdAt: '', updatedAt: '' }
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ consumable: created }),
    })
    const onRegistered = vi.fn()
    render(<ConsumableRegisterForm facilityId="f-1" onRegistered={onRegistered} />)
    await userEvent.type(screen.getByLabelText('品名'), 'ガーゼ')
    await userEvent.type(screen.getByLabelText('JAN'), '490000001')
    await userEvent.type(screen.getByLabelText('用途'), '止血')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))

    expect(await screen.findByRole('button', { name: '登録する' })).not.toBeDisabled()
    expect(fetch).toHaveBeenCalledWith('/api/consumables', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ facilityId: 'f-1', name: 'ガーゼ', purpose: '止血', jan: '490000001' }),
    }))
    expect(onRegistered).toHaveBeenCalledWith(created)
    expect(screen.getByLabelText('品名')).toHaveValue('')
    expect(screen.getByLabelText('JAN')).toHaveValue('')
    expect(screen.getByLabelText('用途')).toHaveValue('')
  })

  it('APIがエラーを返すとエラーメッセージを表示する', async () => {
    ;(fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ error: '他施設の消耗品は登録できません' }),
    })
    render(<ConsumableRegisterForm facilityId="f-1" onRegistered={vi.fn()} />)
    await userEvent.type(screen.getByLabelText('品名'), 'ガーゼ')
    await userEvent.type(screen.getByLabelText('用途'), '止血')
    await userEvent.click(screen.getByRole('button', { name: '登録する' }))
    expect(await screen.findByText('他施設の消耗品は登録できません')).toBeInTheDocument()
  })
})
