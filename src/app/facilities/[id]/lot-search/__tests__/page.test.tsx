import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import LotSearchPage from '../page'

// WHY(issue #803 セットC): ロット検索は施設スコープの読み取り専用画面。
//      API層(セットB)はまだこのworktreeに実装されていない前提で、fetchはモックし
//      契約(LotSearchApiResponse/LotSearchApiErrorResponse、src/types/order.ts)通りの
//      レスポンスを返す想定でUIのみを検証する。

function params(id = 'f-1') {
  const p = Promise.resolve({ id }) as Promise<{ id: string }> & {
    status?: string
    value?: { id: string }
  }
  p.status = 'fulfilled'
  p.value = { id }
  return p
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.clearAllMocks()
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('LotSearchPage', () => {
  it('見出し・入力欄・短貸発注が対象外である旨が表示される', () => {
    render(<LotSearchPage params={params()} />)
    expect(screen.getByRole('heading', { name: 'ロット検索' })).toBeInTheDocument()
    expect(screen.getByLabelText('ロット番号')).toBeInTheDocument()
    expect(screen.getByText(/短貸発注の明細/)).toBeInTheDocument()
    expect(screen.getByText(/対象外/)).toBeInTheDocument()
  })

  it('初期状態では検索結果も0件メッセージも表示されない', () => {
    render(<LotSearchPage params={params()} />)
    expect(screen.queryByText('該当するロットは見つかりませんでした')).not.toBeInTheDocument()
  })

  it('入力が空のまま検索すると、fetchを呼ばずに入力欄のそばにエラーを出す', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<LotSearchPage params={params()} />)
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('1〜100字で入力してください')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('101字以上を入力すると、fetchを呼ばずにエラーを出す', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<LotSearchPage params={params()} />)
    await user.type(screen.getByLabelText('ロット番号'), 'A'.repeat(101))
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('1〜100字で入力してください')).toBeInTheDocument()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('前後の空白だけを落として検索する（決定3=(b)）', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], truncated: false })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), '  LOT-1  ')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    await screen.findByText('該当するロットは見つかりませんでした')
    expect(fetchMock).toHaveBeenCalledWith('/api/facilities/f-1/lot-search?lot=LOT-1')
  })

  it('Enterキーでも検索できる', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ items: [], truncated: false })))
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1{Enter}')

    await screen.findByText('該当するロットは見つかりませんでした')
  })

  it('検索中はボタンが無効になり「検索中」を表示する', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve
        })
    )
    vi.stubGlobal('fetch', fetchMock)
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(screen.getByRole('button', { name: '検索中…' })).toBeDisabled()
    resolveFetch(jsonResponse({ items: [], truncated: false }))
    await screen.findByText('該当するロットは見つかりませんでした')
  })

  it('0件のとき「該当するロットは見つかりませんでした」を表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ items: [], truncated: false }))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('該当するロットは見つかりませんでした')).toBeInTheDocument()
  })

  it('結果を種別つき（文字での区別込み）で一覧表示し、元の発注/返却へのリンクを出す', async () => {
    const items = [
      {
        kind: 'case_order',
        itemId: 'ci-1',
        parentId: 'co-1',
        lot: 'LOT-1',
        jan: '4901234567890',
        quantity: 2,
        occurredAt: '2026-01-05T01:00:00Z',
        patientId: 'P-0001',
        patientInitials: 'T.Y.',
      },
      {
        kind: 'loan_return',
        itemId: 'li-1',
        parentId: 'lr-1',
        lot: 'LOT-1',
        jan: '4901234500000',
        quantity: 1,
        occurredAt: '2026-01-06T01:00:00Z',
        cancelled: false,
      },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ items, truncated: false }))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('症例発注')).toBeInTheDocument()
    expect(screen.getByText('短貸返却')).toBeInTheDocument()
    // WHY(issue #809 セットC): issue #803 でやめた行ごとのリンクを、詳細ページ宛てで復活させる。
    //      当時は一覧ページの行（#order-<id>）へ飛ぶ作りで、一覧が最新50件だけしか持たないため
    //      「踏んでも何も起きないリンク」になっていた。今は parentId で1件だけ取る詳細ページがあるので、
    //      確実に辿れる（# つきのリンクにはしない）。
    const detailLinks = screen.getAllByRole('link', { name: '詳細を見る' })
    expect(detailLinks[0]).toHaveAttribute('href', '/facilities/f-1/case-orders/co-1')
    expect(detailLinks[1]).toHaveAttribute('href', '/facilities/f-1/loan-returns/lr-1')
    // 行を指すフラグメントつきのリンクが残っていないこと（存在しない行へ飛ぶ約束をしない）
    expect(screen.getAllByRole('link').every((l) => !(l.getAttribute('href') ?? '').includes('#'))).toBe(true)
    // WHY(決定 6 を 2026-09-19 に (a)→(b) へ決め直した): 症例発注の行には患者 ID とイニシャルを出す。
    //      発注の詳細ページが無く、ここに出さないと「どの患者に使ったか」が画面のどこからも分からなかった
    expect(screen.getByRole('columnheader', { name: '患者ID' })).toBeInTheDocument()
    expect(screen.getByText('P-0001')).toBeInTheDocument()
    expect(screen.getByText('T.Y.')).toBeInTheDocument()
    // 生きている返却には「取り消し済み」を出さない（対照）
    expect(screen.queryByText('取り消し済み')).not.toBeInTheDocument()
  })

  // WHY(停止②で判明): 取り消しは「その返却の記録は誤りだった」＝実際には返していないかもしれない。
  //      区別なく「短貸返却」と出すと、リコールの担当者は返却済みと読んで院内に残ったロットを取りこぼす。
  //      色だけにせず文字で出す（受け入れ条件「種別は色だけでなく文字でも区別」と同じ理由）
  it('取り消し済みの短貸返却は、行を落とさずに「取り消し済み」と文字で出す', async () => {
    const items = [
      {
        kind: 'loan_return',
        itemId: 'li-9',
        parentId: 'lr-9',
        lot: 'LOT-1',
        jan: '4901234500000',
        quantity: 1,
        occurredAt: '2026-01-06T01:00:00Z',
        cancelled: true,
      },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ items, truncated: false }))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('短貸返却')).toBeInTheDocument()
    expect(screen.getByText('取り消し済み')).toBeInTheDocument()
    expect(screen.getByText(/実際には返却されていない可能性があります/)).toBeInTheDocument()
  })

  // WHY(issue #824): 症例発注の取り消しも短貸返却と同様、区別なく出すと無関係の患者を巻き込む。
  //      短貸返却側のテスト（直上）と対照になるケースとして、症例発注側も機械的に確認する
  it('取り消し済みの症例発注は、行を落とさずに「取り消し済み」と文字で出す（患者IDとイニシャルは表示したまま）', async () => {
    const items = [
      {
        kind: 'case_order',
        itemId: 'ci-9',
        parentId: 'co-9',
        lot: 'LOT-1',
        jan: '4901234567890',
        quantity: 2,
        occurredAt: '2026-01-05T01:00:00Z',
        patientId: 'P-0009',
        patientInitials: 'A.B.',
        cancelled: true,
      },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ items, truncated: false }))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('症例発注')).toBeInTheDocument()
    expect(screen.getByText('取り消し済み')).toBeInTheDocument()
    expect(screen.getByText(/実際には使用されていない可能性があります/)).toBeInTheDocument()
    expect(screen.getByText('P-0009')).toBeInTheDocument()
    expect(screen.getByText('A.B.')).toBeInTheDocument()
  })

  it('短貸返却の行の患者の欄は空欄ではなく「—」を出す（出し忘れと「該当なし」を見分けられるように）', async () => {
    const items = [
      {
        kind: 'loan_return',
        itemId: 'li-1',
        parentId: 'lr-1',
        lot: 'LOT-1',
        jan: '4901234500000',
        quantity: 1,
        occurredAt: '2026-01-06T01:00:00Z',
        cancelled: false,
      },
    ]
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ items, truncated: false }))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    await screen.findByText('短貸返却')
    expect(screen.getAllByText('—')).toHaveLength(2)
  })

  it('上限に当たったとき truncated の案内を表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            items: [
              {
                kind: 'case_order',
                itemId: 'ci-1',
                parentId: 'co-1',
                lot: 'LOT-1',
                jan: '4901234567890',
                quantity: 2,
                occurredAt: '2026-01-05T01:00:00Z',
              },
            ],
            truncated: true,
          })
        )
      )
    )
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(
      await screen.findByText('該当が多いため一部のみ表示しています。ロット番号を長くして絞り込んでください。')
    ).toBeInTheDocument()
  })

  it('通信エラー時、既存画面と同じ形のエラーバナーを表示する', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network error'))))
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('検索に失敗しました')).toBeInTheDocument()
  })

  it('サーバーエラー応答時、応答のerrorメッセージを表示する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ error: '施設が見つかりません' }, { status: 403 })))
    )
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('施設が見つかりません')).toBeInTheDocument()
  })

  // WHY(issue #803「aal1 で『0 件』を返さない」の画面側): MFA 未昇格のセッションで検索すると、proxy が
  //      /mfa-challenge へリダイレクトし、fetch はそれを辿って **200 の HTML** を受け取る（res.ok は true）。
  //      ここで「JSON として読めなければ空として扱う」と書くと、リコールの検索が黙って「該当なし」を出す。
  //      読めない 200 は失敗として見せる、を固定する
  it('200 だが JSON でない応答（proxy のリダイレクト先の HTML）を「0件」と表示しない', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response('<!doctype html><title>MFA</title>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
        )
      )
    )
    const user = userEvent.setup()

    render(<LotSearchPage params={params('f-1')} />)
    await user.type(screen.getByLabelText('ロット番号'), 'LOT-1')
    await user.click(screen.getByRole('button', { name: '検索する' }))

    expect(await screen.findByText('検索に失敗しました')).toBeInTheDocument()
    expect(screen.queryByText('該当するロットは見つかりませんでした')).not.toBeInTheDocument()
  })
})
