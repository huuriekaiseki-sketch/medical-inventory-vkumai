import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
  { id: 'c-1', facilityId: 'f-1', name: 'ガーゼ', jan: '4901234567890', purpose: 'ABL', status: 'active', inUse: false },
]

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

/**
 * WHY(role も返す、2026-09-09): 画面は `useFacilityRole` で書き込み UI を出し分けるようになった。
 *      既定を staff にしておくと従来のテスト（登録フォームが見える）はそのまま通り、
 *      viewer のときの振る舞いは role を差し替えて測れる。
 */
function setupFetch({ consumables = facilityConsumables, role = 'staff', orders = [] as unknown[] } = {}) {
  // WHY(型に init も入れる): 呼び出しの検査（DELETE が飛んだか）で `calls[n][1]` を見るため。
  //      引数を 1 つしか宣言しないと TypeScript がタプル長 1 として弾き、
  //      使わない引数を書くと lint が落ちる。**型だけ**に持たせて両方を満たす
  return vi.fn<(url: string, init?: RequestInit) => unknown>((url: string) => {
    if (typeof url === 'string' && url.includes('/my-role')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ role }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables }) })
    }
    if (typeof url === 'string' && url.startsWith('/api/consumable-orders')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders }) })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })
  })
}

function makeOrder(status: string) {
  return {
    id: 'o-1',
    facilityId: 'f-1',
    status,
    items: [],
    createdAt: '2026-01-05T01:00:00Z',
    updatedAt: '2026-01-05T01:00:00Z',
  }
}

describe('ConsumableOrdersPage', () => {
  // WHY(issue #828): 取り消しの導線は消耗品発注にも出る(OrderHistoryTable)のに、この一覧だけ
  //      cancelled のラベルが無く、英字のまま画面に出ていた(症例発注では直っていた。C-047)
  describe('発注一覧のステータス表示（issue #828）', () => {
    it('cancelledは英字のままでなく「取り消し済」と表示する', async () => {
      global.fetch = setupFetch({ orders: [makeOrder('cancelled')] }) as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params()} />)

      expect(await screen.findByText('取り消し済')).toBeInTheDocument()
      expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
    })

    // WHY(対照): 上のテストが「一覧が描画されていない」ことで通っていないことを、同じ組み立てで確かめる
    it('submittedは「提出済」と表示する(対照)', async () => {
      global.fetch = setupFetch({ orders: [makeOrder('submitted')] }) as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params()} />)

      expect(await screen.findByText('提出済')).toBeInTheDocument()
      expect(screen.queryByText('取り消し済')).not.toBeInTheDocument()
    })
  })

  it('消耗品登録フォームが表示される(AC1)', async () => {
    global.fetch = setupFetch() as unknown as typeof fetch
    render(<ConsumableOrdersPage params={params()} />)
    expect(await screen.findByRole('heading', { name: '消耗品発注' })).toBeInTheDocument()
    expect(await screen.findByLabelText('品名')).toBeInTheDocument()
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
      if (typeof url === 'string' && url.includes('/my-role')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ role: 'staff' }) })
      }
      if (init?.method === 'POST') {
        return Promise.resolve({ ok: true, status: 201, json: () => Promise.resolve({ consumable: { id: 'c-3', facilityId: 'f-1', name: '新規消耗品', jan: null, purpose: 'PCI', status: 'active', inUse: false } }) })
      }
      if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
        callCount += 1
        const consumables = callCount === 1 ? facilityConsumables : [...facilityConsumables, { id: 'c-3', facilityId: 'f-1', name: '新規消耗品', jan: null, purpose: 'PCI', status: 'active', inUse: false }]
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
    }) as unknown as typeof fetch

    render(<ConsumableOrdersPage params={params('f-1')} />)
    await screen.findByText('ガーゼ')

    await user.type(await screen.findByLabelText('品名'), '新規消耗品')
    await user.type(screen.getByLabelText('用途'), 'PCI')
    await user.click(screen.getByRole('button', { name: '登録する' }))

    expect(await screen.findByText('新規消耗品')).toBeInTheDocument()
  })

  // WHY(2026-09-09): 消耗品には直す道も消す道も無かった（作成と一覧だけ）。
  //      DB は施設の writer に UPDATE / DELETE を許していたので、層が食い違っていた（E-055 の裏返し）
  describe('直す・止める・消す道（2026-09-09）', () => {
    it('使用停止も見えるように includeRetired=1 で一覧を引く', async () => {
      const fetchMock = setupFetch()
      global.fetch = fetchMock as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params('f-1')} />)
      await screen.findByText('ガーゼ')
      const urls = fetchMock.mock.calls.map(c => String(c[0]))
      expect(urls.some(u => u.includes('/api/consumables?facilityId=f-1&includeRetired=1'))).toBe(true)
    })

    it('発注で使われていない消耗品には「削除」が出る', async () => {
      global.fetch = setupFetch() as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params('f-1')} />)
      expect(await screen.findByRole('button', { name: '削除' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '使用停止' })).not.toBeInTheDocument()
    })

    it('発注で使われている消耗品には「使用停止」だけが出る（消せないボタンを見せない）', async () => {
      global.fetch = setupFetch({
        consumables: [{ ...facilityConsumables[0], inUse: true }],
      }) as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params('f-1')} />)
      expect(await screen.findByRole('button', { name: '使用停止' })).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument()
    })

    it('viewer には登録フォームも直す・消すボタンも出ない（触れるが何も起きない道を作らない）', async () => {
      global.fetch = setupFetch({ role: 'viewer' }) as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params('f-1')} />)
      expect(await screen.findByText('ガーゼ')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '登録する' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '編集' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '削除' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '使用停止' })).not.toBeInTheDocument()
    })

    it('使用停止のものは印が付き、直す・消すボタンが出ない', async () => {
      global.fetch = setupFetch({
        consumables: [{ ...facilityConsumables[0], status: 'retired', inUse: true }],
      }) as unknown as typeof fetch
      render(<ConsumableOrdersPage params={params('f-1')} />)
      expect(await screen.findByText('使用停止')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '編集' })).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: '使用停止' })).not.toBeInTheDocument()
    })

    it('編集を押して保存すると PUT が飛び、一覧を引き直す', async () => {
      const user = userEvent.setup()
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/my-role')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ role: 'staff' }) })
        }
        if (init?.method === 'PUT') {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumable: { ...facilityConsumables[0], name: 'ガーゼ（大）' } }) })
        }
        if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables: facilityConsumables }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
      })
      global.fetch = fetchMock as unknown as typeof fetch

      render(<ConsumableOrdersPage params={params('f-1')} />)
      await user.click(await screen.findByRole('button', { name: '編集' }))
      // WHY(行の中に絞る): 登録フォームにも「品名」があるので、画面全体から引くと 2 件見つかる
      const row = within(screen.getByTestId('consumable-c-1'))
      await user.clear(row.getByLabelText('品名'))
      await user.type(row.getByLabelText('品名'), 'ガーゼ（大）')
      await user.click(row.getByRole('button', { name: '保存' }))

      const put = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PUT')
      expect(put, 'PUT /api/consumables/[id] が呼ばれていない').toBeTruthy()
      expect(String(put![0])).toBe('/api/consumables/c-1')
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        facilityId: 'f-1',
        name: 'ガーゼ（大）',
        purpose: 'ABL',
        jan: '4901234567890',
      })
    })

    it('使用停止は確認してから PATCH する（戻せないので）', async () => {
      const user = userEvent.setup()
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
      const fetchMock = vi.fn<(url: string, init?: RequestInit) => unknown>((url: string) => {
        if (typeof url === 'string' && url.includes('/my-role')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ role: 'staff' }) })
        }
        if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables: [{ ...facilityConsumables[0], inUse: true }] }) })
        }
        if (typeof url === 'string' && url.startsWith('/api/consumables/')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumable: { ...facilityConsumables[0], status: 'retired' } }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
      })
      global.fetch = fetchMock as unknown as typeof fetch

      render(<ConsumableOrdersPage params={params('f-1')} />)
      await user.click(await screen.findByRole('button', { name: '使用停止' }))

      expect(confirmSpy).toHaveBeenCalled()
      const patch = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PATCH')
      expect(patch, 'PATCH /api/consumables/[id] が呼ばれていない').toBeTruthy()
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ facilityId: 'f-1', action: 'retire' })
    })

    it('確認をキャンセルしたら削除しない', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(false)
      const fetchMock = setupFetch()
      global.fetch = fetchMock as unknown as typeof fetch

      render(<ConsumableOrdersPage params={params('f-1')} />)
      await user.click(await screen.findByRole('button', { name: '削除' }))

      const del = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')
      expect(del, 'キャンセルしたのに DELETE が飛んだ').toBeFalsy()
    })

    it('削除は施設 ID をクエリに付けて DELETE する', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const fetchMock = setupFetch()
      global.fetch = fetchMock as unknown as typeof fetch

      render(<ConsumableOrdersPage params={params('f-1')} />)
      await user.click(await screen.findByRole('button', { name: '削除' }))

      const del = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')
      expect(del, 'DELETE /api/consumables/[id] が呼ばれていない').toBeTruthy()
      expect(String(del![0])).toBe('/api/consumables/c-1?facilityId=f-1')
    })

    it('サーバーが 409 で断ったら、その理由をそのまま見せる', async () => {
      const user = userEvent.setup()
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (typeof url === 'string' && url.includes('/my-role')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ role: 'staff' }) })
        }
        if (init?.method === 'DELETE') {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: 'この消耗品は発注で使われているため削除できません。使用停止にしてください' }),
          })
        }
        if (typeof url === 'string' && url.startsWith('/api/consumables?facilityId=')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ consumables: facilityConsumables }) })
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ orders: [] }) })
      })
      global.fetch = fetchMock as unknown as typeof fetch

      render(<ConsumableOrdersPage params={params('f-1')} />)
      await user.click(await screen.findByRole('button', { name: '削除' }))

      expect(
        await screen.findByText('この消耗品は発注で使われているため削除できません。使用停止にしてください')
      ).toBeInTheDocument()
    })
  })
})
