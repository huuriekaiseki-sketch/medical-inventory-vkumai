import { vi, describe, it, expect, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import limitsConfig from '../../aidd.config.json'

vi.mock('@/lib/supabase/server', () => ({ createServerSupabase: vi.fn().mockResolvedValue({}) }))
vi.mock('@/lib/supabase/require-auth', () => ({ requireAuth: vi.fn().mockResolvedValue({ id: 'u1' }) }))
vi.mock('@/lib/supabase/require-facility-access', () => ({ requireFacilityAccess: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/lib/case-orders/repository')
vi.mock('@/lib/consumable-orders/repository')
vi.mock('@/lib/loan-orders/repository')
vi.mock('@/lib/loan-returns/repository')

import { createCaseOrder } from '@/lib/case-orders/repository'
import { createConsumableOrder } from '@/lib/consumable-orders/repository'
import { createLoanOrder } from '@/lib/loan-orders/repository'
import { createLoanReturn } from '@/lib/loan-returns/repository'

import { POST as caseOrderPOST } from '@/app/api/case-orders/route'
import { POST as consumableOrderPOST } from '@/app/api/consumable-orders/route'
import { POST as loanOrderPOST } from '@/app/api/loan-orders/route'
import { POST as loanReturnPOST } from '@/app/api/loan-returns/route'

function makeRequest(url: string, body: unknown) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

beforeEach(() => vi.resetAllMocks())

describe('consumable-orders エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createConsumableOrder).mockRejectedValue(new Error('DB エラー'))
    const res = await consumableOrderPOST(
      makeRequest('/api/consumable-orders', {
        facilityId: 'f1',
        items: [{ consumableId: 'c1', quantity: 1 }],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })

  // WHY: 生のリポジトリ/DBエラーはClientVisibleErrorでない限りクライアントへ漏らさず
  //      fallbackメッセージのみ返す(architecture review 2026-07-26 issue #3の回帰テスト)
  it('ClientVisibleErrorでない例外はメッセージを漏らさずfallbackを返す', async () => {
    vi.mocked(createConsumableOrder).mockRejectedValue(new Error('relation "consumable_orders" does not exist'))
    const res = await consumableOrderPOST(
      makeRequest('/api/consumable-orders', {
        facilityId: 'f1',
        items: [{ consumableId: 'c1', quantity: 1 }],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('発注に失敗しました')
    expect(body.error).not.toContain('consumable_orders')
  })
})

describe('loan-orders エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createLoanOrder).mockRejectedValue(new Error('DB エラー'))
    const res = await loanOrderPOST(
      makeRequest('/api/loan-orders', {
        facilityId: 'f1',
        procedureName: 'PCI',
        maker: 'M',
        items: [],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

describe('loan-returns エラーハンドリング', () => {
  it('リポジトリ例外を { error: string } 形式でキャッチする', async () => {
    vi.mocked(createLoanReturn).mockRejectedValue(new Error('DB エラー'))
    const res = await loanReturnPOST(
      makeRequest('/api/loan-returns', {
        facilityId: 'f1',
        returnDatetime: '2026-06-25T00:00:00Z',
        items: [],
      })
    )
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })
})

// WHY(#757-20 / I-010): このテストはもともと「0 は falsy なので素朴な検証だと弾かれる」という
//      罠を守るためのものだった。その後 2026-09-06 に不変条件 I-010（数量は 1 以上）が DB の
//      CHECK として入り、**0 は業務として無効**になった。API が 0 を通すと DB で 23514 になり、
//      利用者には何が悪いか伝わらない。入口で 400 にするのが正しい。
//      falsy の罠は「1 は通る」側で守る。
describe('数量は 1 以上（I-010 を入口でも守る）', () => {
  it('case-orders: quantity 0 は 400 で、何が悪いか文言に出る', async () => {
    vi.mocked(createCaseOrder).mockResolvedValue({
      id: 'o1',
      facilityId: 'f1',
      caseDatetime: '2026-06-25T00:00:00Z',
      procedureName: 'PCI',
      patientId: 'p1',
      patientInitials: 'AB',
      gender: 'male',
      doctorName: 'Dr',
      status: 'draft',
      items: [],
      createdAt: '',
      updatedAt: '',
    })
    const res = await caseOrderPOST(
      makeRequest('/api/case-orders', {
        facilityId: 'f1',
        caseDatetime: '2026-06-25T00:00:00Z',
        procedureName: 'PCI',
        patientId: 'p1',
        patientInitials: 'AB',
        gender: 'male',
        doctorName: 'Dr',
        items: [{ jan: '4901234567890', quantity: 0 }],
      })
    )
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toContain('数量')
    expect(createCaseOrder).not.toHaveBeenCalled()
  })

  it('case-orders: quantity 1 は通る（0 が falsy であることに引きずられない）', async () => {
    const res = await caseOrderPOST(
      makeRequest('/api/case-orders', {
        facilityId: 'f1',
        caseDatetime: '2026-06-25T00:00:00Z',
        procedureName: 'PCI',
        patientId: 'p1',
        patientInitials: 'AB',
        gender: 'male',
        doctorName: 'Dr',
        items: [{ jan: '4901234567890', quantity: 1 }],
      })
    )
    expect(res.status).toBe(201)
  })
})

// WHY(issue #813): スキーマの単体テスト（validation/__tests__/order-items-limit.test.ts）は「スキーマが止める」を
//      見るだけ。利用者に届くのは route の応答なので、**400 と文言が返り、保存の処理まで進まない**ことをここで見る。
//      4 種の route はそれぞれ別のファイルなので、1 つだけ見て残りを信じない
describe('明細の件数の上限（issue #813。入口で 400、保存まで進まない）', () => {
  const LIMIT = limitsConfig.limits.orderItemsMax
  const janItems = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ jan: `49000000${String(i).padStart(5, '0')}`, quantity: 1 }))

  const cases = [
    {
      name: 'case-orders',
      post: caseOrderPOST,
      create: createCaseOrder,
      url: '/api/case-orders',
      body: (n: number) => ({
        facilityId: 'f1',
        caseDatetime: '2026-06-25T00:00:00Z',
        procedureName: 'PCI',
        patientId: 'p1',
        patientInitials: 'AB',
        gender: 'male',
        doctorName: 'Dr',
        items: janItems(n),
      }),
    },
    {
      name: 'loan-orders',
      post: loanOrderPOST,
      create: createLoanOrder,
      url: '/api/loan-orders',
      body: (n: number) => ({
        facilityId: 'f1',
        procedureName: 'PCI',
        maker: 'メーカー',
        items: Array.from({ length: n }, (_, i) => ({ name: `品名${i}`, quantity: 1 })),
      }),
    },
    {
      name: 'loan-returns',
      post: loanReturnPOST,
      create: createLoanReturn,
      url: '/api/loan-returns',
      body: (n: number) => ({ facilityId: 'f1', returnDatetime: '2026-06-25T00:00:00Z', items: janItems(n) }),
    },
    {
      name: 'consumable-orders',
      post: consumableOrderPOST,
      create: createConsumableOrder,
      url: '/api/consumable-orders',
      body: (n: number) => ({
        facilityId: 'f1',
        items: Array.from({ length: n }, () => ({ consumableId: 'c1', quantity: 1 })),
      }),
    },
  ]

  for (const c of cases) {
    it(`${c.name}: 上限を 1 件超えると 400 で、何件までかが伝わり、保存の処理は呼ばれない`, async () => {
      const res = await c.post(makeRequest(c.url, c.body(LIMIT + 1)))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.error).toBe(`明細は ${LIMIT} 件までです`)
      expect(c.create).not.toHaveBeenCalled()
    })

    it(`${c.name}: ちょうど上限の件数は保存の処理まで進む（境界の内側。止めすぎていない）`, async () => {
      await c.post(makeRequest(c.url, c.body(LIMIT)))
      expect(c.create).toHaveBeenCalledTimes(1)
    })
  }
})
