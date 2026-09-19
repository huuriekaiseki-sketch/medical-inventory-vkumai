import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import LoanReturnsPage from '../page'

// WHY(issue #809 セットC): 詳細ページへのリンク追加のみを検証する。
//      既存の取り消し挙動(handleCancel等)は今回触っていないためここでは対象外。

function params(id = 'f-1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & { status?: string; value?: { id: string } }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as Response
}

function makeReturn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r-1',
    facilityId: 'f-1',
    returnDatetime: '2026-01-06T01:00:00Z',
    status: 'returned',
    items: [],
    createdAt: '2026-01-06T01:00:00Z',
    updatedAt: '2026-01-06T01:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('LoanReturnsPage', () => {
  it('各行に詳細ページへのリンクがある', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ returns: [makeReturn()] }))))
    render(<LoanReturnsPage params={params('f-1')} />)

    expect(await screen.findByRole('link', { name: '詳細を見る' })).toHaveAttribute(
      'href',
      '/facilities/f-1/loan-returns/r-1'
    )
  })

  it('取り消し済みの行でも既存の取り消しボタンは操作列に引き続き表示されない(取り消し済みのため)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ returns: [makeReturn({ status: 'cancelled' })] }))))
    render(<LoanReturnsPage params={params('f-1')} />)

    await screen.findByRole('link', { name: '詳細を見る' })
    expect(screen.queryByRole('button', { name: '取り消す' })).not.toBeInTheDocument()
  })
})
