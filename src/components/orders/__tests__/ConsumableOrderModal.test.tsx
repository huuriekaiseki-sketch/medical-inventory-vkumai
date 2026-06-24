import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ConsumableOrderModal } from '../ConsumableOrderModal'

const mockConsumables = [
  { id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '490000001', purpose: '止血', createdAt: '', updatedAt: '' },
  { id: 'c-2', facilityId: 'f-1', name: 'シリンジ', jan: undefined, purpose: '注射', createdAt: '', updatedAt: '' },
]

describe('ConsumableOrderModal', () => {
  beforeEach(() => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/consumables')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ consumables: mockConsumables }) })
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ order: { id: 'coo-1' } }) })
    })
  })

  it('isOpen=falseのとき何も描画しない', () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={false} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(screen.queryByText('消耗品発注')).not.toBeInTheDocument()
  })

  it('isOpen=trueのとき消耗品一覧がロードされて表示される', async () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    expect(await screen.findByText('ガーゼ')).toBeInTheDocument()
    expect(screen.getByText('シリンジ')).toBeInTheDocument()
  })

  it('消耗品を選択して発注するとPOSTが呼ばれる', async () => {
    const onSuccess = vi.fn()
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={onSuccess} />)
    await screen.findByText('ガーゼ')
    await userEvent.click(screen.getAllByRole('checkbox')[0])
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalledWith('/api/consumable-orders', expect.objectContaining({ method: 'POST' }))
    expect(onSuccess).toHaveBeenCalled()
  })

  it('1件も選択せずに送信するとエラーが表示される', async () => {
    render(<ConsumableOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await screen.findByText('ガーゼ')
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(await screen.findByText('発注物品を1つ以上選択してください')).toBeInTheDocument()
  })
})
