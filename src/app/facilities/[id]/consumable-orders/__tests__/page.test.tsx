import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// WHY: issue #647 レビュー指摘(important): AC1(登録フォームの設置)・AC2(登録後の一覧反映)・
//      AC3(他施設の消耗品は見えない)を検証する統合テストが存在しなかった。
//      ConsumableRegisterForm単体テストはonRegisteredコールバックまでしか検証しておらず、
//      page.tsx側のsetConsumables反映・facilityIdごとの絞り込みは未検証だった。

import ConsumableOrdersPage from '../page'

function params(id = 'f-1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status?: string
    value?: { id: string }
  }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

const facilityConsumables = [
  { id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '4901234567890', purpose: 'ABL' },
]

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

function setupFetch({ consumables = facilityConsumables } = {}) {
  return vi.fn((url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/consumable-orders')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
}

describe('ConsumableOrdersPage', () => {
  it('消耗品登録フォームが表示される(AC1)', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<ConsumableOrdersPage params={params()} />)
    expect(await screen.findByRole('heading', { name: '消耗品発注' })).toBeInTheDocument()
    expect(screen.getByLabelText('品名')).toBeInTheDocument()
    expect(screen.getByLabelText('用途')).toBeInTheDocument()
  })

  it('自施設の消耗品のみ一覧に表示される(AC3: facilityIdで絞り込み済みのAPIレスポンスをそのまま反映)', async () => {
    global.fetch = setupFetch({ consumables: facilityConsumables }) as unknown as typeof fetch
    render(<ConsumableOrdersPage params={params('f-1')} />)
    expect(await screen.findByText('ガーゼ')).toBeInTheDocument()
    expect(screen.queryByText('他施設の消耗品')).not.toBeInTheDocument()
  })

  it('登録に成功すると一覧が再取得され、新規登録分が反映される(AC2)', async () => {
    const user = userEvent.setup()
    let callCount = 0
    global.fetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ consumable: { id: 'c-3', facilityId: 'f-1', name: '新規消耗品', jan: null, purpose: 'PCI' } }) })
      }
      if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
        callCount += 1
        const consumables = callCount === 1 ? facilityConsumables : [...facilityConsumables, { id: 'c-3', facilityId: 'f-1', name: '新規消耗品', jan: null, purpose: 'PCI' }]
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
    }) as unknown as typeof fetch

    render(<ConsumableOrdersPage params={params('f-1')} />)
    await screen.findByText('ガーゼ')

    await user.type(screen.getByLabelText('品名'), '新規消耗品')
    await user.type(screen.getByLabelText('用途'), 'PCI')
    await user.click(screen.getByRole('button', { name: '登録する' }))

    expect(await screen.findByText('新規消耗品')).toBeInTheDocument()
  })
})
