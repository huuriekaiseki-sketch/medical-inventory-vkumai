import { describe, it, expect } from 'vitest'
import { apiError, authGuardError, repositoryError } from '@/lib/api-error'
import { ClientVisibleError } from '@/lib/client-visible-error'

describe('apiError', () => {
  it('{ error: string } 形式で返す', async () => {
    const res = apiError('失敗しました')
    const body = await res.json()
    expect(body).toEqual({ error: '失敗しました' })
  })

  it('デフォルトステータスは 500', () => {
    const res = apiError('失敗しました')
    expect(res.status).toBe(500)
  })

  it('ステータスを指定できる', () => {
    const res = apiError('見つかりません', 404)
    expect(res.status).toBe(404)
  })
})

// WHY(#757-7): ミューテーションテストで、上限超過を 429 に分ける判定が 1 つも検査されて
//      いないことが分かった（変異が生き残った）。ここを取り違えると上限超過が 401 に化けて
//      「なぜ弾かれたのか」が分からなくなる（P-064）
describe('authGuardError', () => {
  it('RATE_LIMITED は 429 にする', async () => {
    const res = authGuardError(new Error('RATE_LIMITED'))
    expect(res.status).toBe(429)
    const body = await res.json()
    expect(body.error).toContain('リクエストが多すぎます')
  })

  it('UNAUTHORIZED は 401 にする', async () => {
    const res = authGuardError(new Error('UNAUTHORIZED'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toBe('認証が必要です')
  })

  it('知らないエラーも 401 にする（未認証として扱い、通さない）', () => {
    expect(authGuardError(new Error('boom')).status).toBe(401)
  })

  it('Error でない値でも 401 にする', () => {
    expect(authGuardError('RATE_LIMITED').status).toBe(401)
    expect(authGuardError(null).status).toBe(401)
  })
})

// WHY(2026-09-08): ClientVisibleError を 400 で返していたのは短貸返却だけで、症例発注・
//      短貸発注・消耗品発注は文言だけ差し替えて 500 のままだった。利用者が自分で直せる
//      間違い（未登録の JAN・業務ルール違反・重複）が「サーバーの故障」に見えていた。
describe('repositoryError', () => {
  it('ClientVisibleError は 400 で、その文言をそのまま返す', async () => {
    const res = repositoryError(new ClientVisibleError('製品マスタに登録されていない JAN です: 123'), '返却に失敗しました')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('製品マスタに登録されていない JAN です: 123')
  })

  it('それ以外は 500 で、fallback の文言だけを返す（生のエラーを漏らさない）', async () => {
    const res = repositoryError(new Error('relation "loan_returns" does not exist'), '返却に失敗しました')
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe('返却に失敗しました')
    expect(body.error).not.toContain('loan_returns')
  })

  it('Error でない値でも 500 と fallback にする', async () => {
    const res = repositoryError('boom', '発注に失敗しました')
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('発注に失敗しました')
  })
})
