import { describe, it, expect, vi, afterEach } from 'vitest'
import { logServerError, redactForLog, scrubLogText } from './log-safe'

// WHY: issue #757 の 5。PostgreSQL / PostgREST のエラーは行の中身を DETAIL に載せるので、
//      ログに出す前に伏せる。ここでは「患者 ID・イニシャル・医師名・メールが出力に一切現れない」を
//      RED 方向（伏せ忘れたら落ちる）で固定する。

const PATIENT_ID = 'PT-SECRET-4242'
const INITIALS = 'T.K.'
const DOCTOR = '山田太郎医師'
const EMAIL = 'real.person@example.org'

const pgCheckViolation = {
  code: '23514',
  message: 'new row for relation "case_orders" violates check constraint "case_orders_gender_check"',
  details: `Failing row contains (7c1e, f1, 2026-09-06 00:00:00+00, 手術, ${PATIENT_ID}, ${INITIALS}, x, ${DOCTOR}, draft).`,
  hint: null,
}

describe('scrubLogText', () => {
  it('Failing row contains (...) の中身を伏せる', () => {
    const out = scrubLogText(`DETAIL: Failing row contains (1, ${PATIENT_ID}, ${DOCTOR}).`)
    expect(out).toBe('DETAIL: Failing row contains ([redacted]).')
  })

  it('Key (col)=(value) の値だけ伏せ、列名は残す', () => {
    const out = scrubLogText('Key (jan)=(4901234567890) already exists.')
    expect(out).toBe('Key (jan)=([redacted]) already exists.')
  })

  it('メールアドレスを伏せる', () => {
    expect(scrubLogText(`invite failed for ${EMAIL}`)).toBe('invite failed for [email]')
  })
})

describe('redactForLog', () => {
  it('PostgREST のエラーオブジェクトは details / hint を捨て、code と伏せた message だけ残す', () => {
    const record = redactForLog(pgCheckViolation)
    const text = JSON.stringify(record)
    expect(record.code).toBe('23514')
    expect(record.hadDetails).toBe(true)
    expect(text).not.toContain(PATIENT_ID)
    expect(text).not.toContain(INITIALS)
    expect(text).not.toContain(DOCTOR)
    expect(text).not.toContain('Failing row')
  })

  it('Error に details が生えていても中身は出さない', () => {
    const error = Object.assign(new Error(`duplicate key value violates unique constraint "x"`), {
      code: '23505',
      details: `Key (email)=(${EMAIL}) already exists.`,
    })
    const record = redactForLog(error)
    const text = JSON.stringify(record)
    expect(record.name).toBe('Error')
    expect(record.code).toBe('23505')
    expect(text).not.toContain(EMAIL)
  })

  it('message にメールが混ざっていても伏せる', () => {
    const record = redactForLog(new Error(`user ${EMAIL} not found`))
    expect(record.message).toBe('user [email] not found')
  })

  it('文字列・数値・null も落ちずに扱う', () => {
    expect(redactForLog(`Failing row contains (${PATIENT_ID})`).message).toBe('Failing row contains ([redacted])')
    expect(redactForLog(42).message).toBe('42')
    expect(redactForLog(null).message).toBe('null')
  })

  // WHY(2026-09-07 のミューテーション計測): ここから下は「効き目 62%」の内訳を埋める分。
  //      それまでのテストは**幸せな形**（details も hint も name も code も揃っている
  //      PostgREST のエラー）しか通しておらず、`hadDetails` の式や各フォールバックを
  //      別の値に書き換えても 1 件も落ちなかった。境目を 1 つずつ固定する。

  it.each([
    { label: 'どちらも無い', input: {}, expected: false },
    { label: 'details だけ', input: { details: 'x' }, expected: true },
    { label: 'hint だけ', input: { hint: 'x' }, expected: true },
    { label: '両方ある', input: { details: 'x', hint: 'y' }, expected: true },
    { label: 'details が null', input: { details: null }, expected: false },
    { label: 'hint が null', input: { hint: null }, expected: false },
    { label: 'details が空文字（値はある）', input: { details: '' }, expected: true },
  ])('hadDetails: $label → $expected', ({ input, expected }) => {
    // WHY(4 通り全部を測る): `details != null || hint != null` は `&&` にしても
    //      `true` 固定にしても `false` 固定にしても、片方しか試さないテストでは落ちない。
    expect(redactForLog(input).hadDetails).toBe(expected)
    // Error の形でも同じ（Error 専用の分岐は消したので、同じ経路を通る）
    expect(redactForLog(Object.assign(new Error('x'), input)).hadDetails).toBe(expected)
  })

  it('name が無い・文字列でないオブジェクトは Object に落とす', () => {
    expect(redactForLog({ message: 'x' }).name).toBe('Object')
    expect(redactForLog({ name: 123, message: 'x' }).name).toBe('Object')
    expect(redactForLog({ name: 'PostgrestError', message: 'x' }).name).toBe('PostgrestError')
  })

  it('code が無い・文字列でなければ undefined にする（数値の code を混ぜない）', () => {
    expect(redactForLog({ message: 'x' }).code).toBeUndefined()
    expect(redactForLog({ code: 23514, message: 'x' }).code).toBeUndefined()
    expect(redactForLog({ code: '23514', message: 'x' }).code).toBe('23514')
  })

  it('message が無い・文字列でなければ空文字にする（中身を素通しにしない）', () => {
    // WHY: ここを `typeof o.message === 'string' ? o.message : ''` から素通しに変えると、
    //      オブジェクトがそのままログに出る。そこに行の中身が入りうるので、
    //      伏せ字を通らない経路を作らない。
    expect(redactForLog({ name: 'X' }).message).toBe('')
    expect(redactForLog({ name: 'X', message: { patientId: PATIENT_ID } }).message).toBe('')
    expect(redactForLog({ name: 'X', message: `id=${PATIENT_ID}` }).message).toBe(`id=${PATIENT_ID}`)
  })

  it('プリミティブは typeof を name にし、hadDetails は必ず false', () => {
    expect(redactForLog('boom')).toEqual({ name: 'string', message: 'boom', hadDetails: false })
    expect(redactForLog(42).name).toBe('number')
    expect(redactForLog(undefined).name).toBe('undefined')
    expect(redactForLog(undefined).hadDetails).toBe(false)
    expect(redactForLog(null).name).toBe('object')
  })

  it('Error と同じ形のプレーンオブジェクトは同じ結果になる（Error 専用の分岐を消した根拠）', () => {
    const shape = { name: 'Error', message: `user ${EMAIL} not found`, code: '23505', details: 'x' }
    const fromError = redactForLog(
      Object.assign(new Error(shape.message), { code: shape.code, details: shape.details }),
    )
    expect(fromError).toEqual(redactForLog(shape))
    expect(fromError.message).toBe('user [email] not found')
  })
})

describe('logServerError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('console.error には伏せた record だけを渡し、生のエラーは渡さない', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    logServerError('api/case-orders', pgCheckViolation)
    expect(spy).toHaveBeenCalledTimes(1)
    const printed = JSON.stringify(spy.mock.calls[0])
    expect(printed).toContain('[api/case-orders]')
    expect(printed).toContain('23514')
    expect(printed).not.toContain(PATIENT_ID)
    expect(printed).not.toContain(DOCTOR)
  })
})
