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
