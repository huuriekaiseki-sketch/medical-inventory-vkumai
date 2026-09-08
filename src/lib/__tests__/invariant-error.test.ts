import { describe, it, expect } from 'vitest'
import { toRepositoryError, isCheckViolation, INVARIANT_VIOLATION_MESSAGE, UNKNOWN_JAN_MESSAGE } from '@/lib/invariant-error'
import { ClientVisibleError } from '@/lib/client-visible-error'

// WHY: 2026-09-08 の E2E で、製品マスタに無い JAN を入れると利用者に
//      500「返却に失敗しました」しか返らないことが分かった（原因は loan_return_items_jan_fkey）。
//      利用者が自分で直せる間違いなので 400 と「未登録である」ことを返す。
//      ここが黙って壊れると、また「サーバーの故障」に見える形へ戻る。
//
// WHY(文言を定数ではなく文字列で確かめる・同日にミューテーションで判明): 最初の版は
//      `expect(e.message).toBe(INVARIANT_VIOLATION_MESSAGE)` と書いていた。
//      これは**定数と定数を比べているだけ**なので、定数を空文字に書き換えても通ってしまう
//      （Stryker で実測: 文言 2 つの変異がどちらも生き残った）。
//      利用者に届く文字そのものを確かめる。

describe('isCheckViolation', () => {
  it('23514 なら true', () => {
    expect(isCheckViolation({ code: '23514' })).toBe(true)
  })

  it('別のコードなら false', () => {
    expect(isCheckViolation({ code: '23503' })).toBe(false)
  })

  it('null / undefined でも落ちない（呼び出し元がエラー無しで呼ぶ経路がある）', () => {
    // WHY: `error?.code` の `?.` を外す変異が生き残った。null を渡す経路を誰も試していなかった
    expect(isCheckViolation(null)).toBe(false)
    expect(isCheckViolation(undefined)).toBe(false)
  })
})

describe('toRepositoryError', () => {
  it('23514（業務ルール違反）は利用者向けの文言に写す', () => {
    const e = toRepositoryError({ code: '23514', message: 'new row violates check constraint "x"' })
    expect(e).toBeInstanceOf(ClientVisibleError)
    // 定数ではなく、利用者に届く文字そのもので確かめる
    expect(e.message).toBe('入力値が業務ルールに反しています（数量は 1 以上、金額は 0 以上、状態は戻せません）')
    expect(INVARIANT_VIOLATION_MESSAGE).toBe(e.message)
  })

  it('23503 の JAN 外部キー違反は「未登録の JAN」として、入れた値ごと返す', () => {
    const e = toRepositoryError({
      code: '23503',
      message: 'insert or update on table "loan_return_items" violates foreign key constraint "loan_return_items_jan_fkey"',
      details: 'Key (jan)=(9999999999999) is not present in table "products".',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toBe('製品マスタに登録されていない JAN です: 9999999999999。先に製品マスタへ登録してください')
    expect(UNKNOWN_JAN_MESSAGE).toBe('製品マスタに登録されていない JAN です')
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

  it('DETAIL が無いときは値を添えない（推測で埋めない）', () => {
    // WHY: `details ?? ''` の空文字を別の文字列に変える変異が生き残った。
    //      「文言は出る」だけでなく「**値は出ない**」まで確かめる
    const e = toRepositoryError({
      code: '23503',
      message: 'violates foreign key constraint "loan_return_items_jan_fkey"',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toBe('製品マスタに登録されていない JAN です。先に製品マスタへ登録してください')
    expect(e.message).not.toContain(':')
  })

  it('DETAIL はあるが形が違うときも値を添えない（想定と違う DETAIL で落ちない）', () => {
    // WHY: `m?.[1]` の `?.` を外す変異が生き残った。**DETAIL はあるが Key (jan)=(...) を含まない**
    //      経路を誰も試していなかった。PostgreSQL の文言は版で変わりうるので、
    //      形が違っても落ちずに「値なし」の文言になることを確かめる
    const e = toRepositoryError({
      code: '23503',
      message: 'violates foreign key constraint "loan_return_items_jan_fkey"',
      details: 'Some other detail without the expected shape.',
    })
    expect(e).toBeInstanceOf(ClientVisibleError)
    expect(e.message).toBe('製品マスタに登録されていない JAN です。先に製品マスタへ登録してください')
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

  it('コードが 23503 でなければ、制約名が JAN のものでも写さない', () => {
    // WHY: `code === '23503' &&` を `true &&` にする変異が生き残った。
    //      コードを見ずに制約名だけで判断すると、別の失敗まで「未登録の JAN」に化ける
    const e = toRepositoryError({
      code: '42501',
      message: 'permission denied for constraint loan_return_items_jan_fkey',
      details: 'Key (jan)=(123) is not present in table "products".',
    })
    expect(e).not.toBeInstanceOf(ClientVisibleError)
    expect(e.message).toContain('permission denied')
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
