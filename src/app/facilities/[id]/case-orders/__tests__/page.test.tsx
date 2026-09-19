import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import CaseOrdersPage from '../page'

// WHY(issue #809 セットC): 既存バグ修正(cancelledラベル欠落)と詳細ページへのリンク追加のみを検証する。
//      一覧の基本挙動(読み込み中・0件表示等)は既存の目視確認済み挙動でここでは対象外。

function params(id = 'f-1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & { status?: string; value?: { id: string } }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'o-1',
    facilityId: 'f-1',
    caseDatetime: '2026-01-05T01:00:00Z',
    procedureName: '虫垂切除術',
    patientId: 'P-1',
    patientInitials: 'T.Y.',
    gender: 'male',
    doctorName: '山田',
    status: 'submitted',
    items: [],
    createdAt: '2026-01-05T01:00:00Z',
    updatedAt: '2026-01-05T01:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('CaseOrdersPage', () => {
  it('cancelledは英字のままでなく「取り消し済」と表示する(既存バグ修正)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ orders: [makeOrder({ status: 'cancelled' })] }))))
    render(<CaseOrdersPage params={params()} />)

    expect(await screen.findByText('取り消し済')).toBeInTheDocument()
    expect(screen.queryByText('cancelled')).not.toBeInTheDocument()
  })

  it('各行に詳細ページへのリンクがある', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ orders: [makeOrder()] }))))
    render(<CaseOrdersPage params={params('f-1')} />)

    expect(await screen.findByRole('link', { name: '詳細を見る' })).toHaveAttribute(
      'href',
      '/facilities/f-1/case-orders/o-1'
    )
  })
})
