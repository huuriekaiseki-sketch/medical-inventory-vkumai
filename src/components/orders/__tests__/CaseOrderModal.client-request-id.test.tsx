import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CaseOrderModal } from '../CaseOrderModal'

// WHY: 二重送信対策の鍵（P-053）は「失敗して再送しても同じ鍵」「成功して次の発注に移ったら新しい鍵」
//      でなければ意味が無い。前者が崩れると再送で 2 件でき、後者が崩れると 2 件目の発注が
//      1 件目に吸収される。fetch の body で鍵の同一性を固定する。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText(/症例日時/), '2026-06-24T10:00')
  await userEvent.type(screen.getByLabelText(/手技名/), 'TAVI')
  await userEvent.type(screen.getByLabelText(/患者ID/), 'P001')
  await userEvent.type(screen.getByLabelText(/患者イニシャル/), 'T.S.')
  await userEvent.type(screen.getByLabelText(/担当医師/), '田中医師')
  await userEvent.click(screen.getByRole('button', { name: '発注する' }))
}

const bodyOf = (call: number) => JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[call][1].body)

describe('CaseOrderModal の clientRequestId', () => {
  beforeEach(() => {
    global.fetch = vi.fn()
  })

  it('送信 body に UUID の clientRequestId が入る', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: () => Promise.resolve({ order: { id: 'co-1' } }) })
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await fillAndSubmit()
    expect(bodyOf(0).clientRequestId).toMatch(UUID_RE)
  })

  it('失敗して再送しても同じ鍵を送る（通信断後のリトライで 2 件にならない）', async () => {
    ;(fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, json: () => Promise.resolve({ error: '送信に失敗しました' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ order: { id: 'co-1' } }) })
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await fillAndSubmit()
    expect(await screen.findByText('送信に失敗しました')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '発注する' }))
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).clientRequestId).toBe(bodyOf(0).clientRequestId)
  })

  it('成功して次の発注を送ると新しい鍵になる（2 件目が 1 件目に吸収されない）', async () => {
    ;(fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, json: () => Promise.resolve({ order: { id: 'co-1' } }) })
    render(<CaseOrderModal facilityId="f-1" isOpen={true} onClose={vi.fn()} onSuccess={vi.fn()} />)
    await fillAndSubmit()
    await fillAndSubmit()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(bodyOf(1).clientRequestId).toMatch(UUID_RE)
    expect(bodyOf(1).clientRequestId).not.toBe(bodyOf(0).clientRequestId)
  })
})
