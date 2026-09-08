import { describe, it, expect } from 'vitest'
import { toRepositoryError, INVARIANT_VIOLATION_MESSAGE, UNKNOWN_JAN_MESSAGE } from '@/lib/invariant-error'
import { ClientVisibleError } from '@/lib/client-visible-error'

// WHY: 2026-09-08 の E2E で、製品マスタに無い JAN を入れると利用者に
//      500「返却に失敗しました」しか返らないことが分かった（原因は loan_return_items_jan_fkey）。
//      利用者が自分で直せる間違いなので 400 と「未登録である」ことを返す。
//      ここが黙って壊れると、また「サーバーの故障」に見える形へ戻る。
describe('toRepositoryError', () => {
  it('23514（業務ルール違反）は利用者向けの文言に写す', () => {
    const e = toRepositoryError({ code: '23514', message: 'new row violates check constraint "x"' })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toBe(INVARIANT_VIOLATION_MESSAGE)
  })

  it('23503 の JAN 外部キー違反は「未登録の JAN」として、入れた値ごと返す', () => {
    const e = toRepositoryError({
      code: '23503',
      message: 'insert or update on table "loan_return_items" violates foreign key constraint "loan_return_items_jan_fkey"',
      details: 'Key (jan)=(9999999999999) is not present in table "products".',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toContain(UNKNOWN_JAN_MESSAGE)
    expect(e.message).toContain('9999999999999')
  })

  it.each([
    'case_order_items_jan_fkey',
    'loan_order_items_jan_fkey',
    'loan_return_items_jan_fkey',
  ])('3 つの明細表すべてで効く: %s', (constraint) => {
    const e = toRepositoryError({
      code: '23503',
      message: `insert or update on table "x" violates foreign key constraint "${constraint}"`,
      details: 'Key (jan)=(4901234567890) is not present in table "products".',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toContain('4901234567890')
  })

  it('DETAIL が無くても利用者向けの文言にはする（値は添えない）', () => {
    const e = toRepositoryError({
      code: '23503',
      message: 'violates foreign key constraint "loan_return_items_jan_fkey"',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toContain(UNKNOWN_JAN_MESSAGE)
  })

  it('DETAIL の表名は返さない（スキーマ情報を漏らさない）', () => {
    const e = toRepositoryError({
      code: '23503',
      message: 'violates foreign key constraint "loan_return_items_jan_fkey"',
      details: 'Key (jan)=(4901234567890) is not present in table "products".',
    })
    expect(e.message).not.toContain('products')
    expect(e.message).not.toContain('loan_return_items')
    expect(e.message).not.toContain('fkey')
  })

  it('JAN 以外の外部キー違反は利用者に見せない（生のエラーのまま route が伏せる）', () => {
    const e = toRepositoryError({
      code: '23503',
      message: 'insert or update on table "loan_returns" violates foreign key constraint "loan_returns_facility_id_fkey"',
      details: 'Key (facility_id)=(...) is not present in table "facilities".',
    })
    expect(e).not.toBeInstanceOf(ClientVisibleError)
  })

  it('知らないコードは生のエラーのまま返す', () => {
    const e = toRepositoryError({ code: '42P01', message: 'relation "x" does not exist' })
    expect(e).not.toBeInstanceOf(ClientVisibleError)
    expect(e.message).toBe('relation "x" does not exist')
  })
})
