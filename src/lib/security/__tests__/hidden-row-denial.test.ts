// WHY(#757-24 の残り): RLS で見えなかった 1 件取得を「存在するなら拒否」として記録する裏方。
//      固定するのは (1) 存在するときだけ記録し facility_id を行から取る、(2) 無い・失敗・環境変数なしでは
//      記録せず例外も投げない（fail-open）、(3) 呼び出し元に存在の有無を返さない。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const maybeSingle = vi.fn()
const chain = {
  select: vi.fn(() => chain),
  eq: vi.fn(() => chain),
  maybeSingle: (...args: unknown[]) => maybeSingle(...args),
}
const from = vi.fn(() => chain)
const createClient = vi.fn(() => ({ from }))
const recordAccessDenial = vi.fn()
const logServerError = vi.fn()

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClient(...(args as [])),
}))
vi.mock('@/lib/security/access-denial', () => ({
  recordAccessDenial: (...args: unknown[]) => recordAccessDenial(...args),
}))
vi.mock('@/lib/log-safe', () => ({
  logServerError: (...args: unknown[]) => logServerError(...args),
}))

async function loadModule() {
  vi.resetModules()
  return import('../hidden-row-denial')
}

describe('RLS で見えない 1 件取得の記録（recordHiddenRowDenial） [P-063]', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    maybeSingle.mockResolvedValue({ data: null, error: null })
    recordAccessDenial.mockResolvedValue(undefined)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  })

  it('facilities: 行があれば guard=facility / reason=forbidden で、facility_id は要求された ID', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'fac-A' }, error: null })
    const m = await loadModule()
    await m.recordHiddenRowDenial({ table: 'facilities', id: 'fac-A', actorId: 'u-B' })
    expect(from).toHaveBeenCalledWith('facilities')
    expect(chain.select).toHaveBeenCalledWith('id')
    expect(chain.eq).toHaveBeenCalledWith('id', 'fac-A')
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'facility', reason: 'forbidden', actorId: 'u-B', facilityId: 'fac-A',
    })
  })

  it('hospital_prices: 行があれば facility_id を行から取って記録する', async () => {
    maybeSingle.mockResolvedValue({ data: { facility_id: 'fac-A' }, error: null })
    const m = await loadModule()
    await m.recordHiddenRowDenial({ table: 'hospital_prices', id: 'hp-1', actorId: 'u-B' })
    expect(from).toHaveBeenCalledWith('hospital_prices')
    expect(chain.select).toHaveBeenCalledWith('facility_id')
    expect(recordAccessDenial).toHaveBeenCalledWith({
      guard: 'facility', reason: 'forbidden', actorId: 'u-B', facilityId: 'fac-A',
    })
  })

  it('行が無ければ記録しない（本当に存在しない 404）', async () => {
    const m = await loadModule()
    await m.recordHiddenRowDenial({ table: 'facilities', id: 'no-such', actorId: 'u-B' })
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('存在確認が error を返したら記録しない（uuid でない ID など）。例外も投げない', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { code: '22P02', message: 'invalid input syntax for type uuid' } })
    const m = await loadModule()
    await expect(
      m.recordHiddenRowDenial({ table: 'hospital_prices', id: 'not-a-uuid', actorId: 'u-B' })
    ).resolves.toBeUndefined()
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('存在確認が throw しても飲み込み、理由を logServerError に残す', async () => {
    maybeSingle.mockRejectedValue(new Error('db down'))
    const m = await loadModule()
    await expect(
      m.recordHiddenRowDenial({ table: 'facilities', id: 'fac-A', actorId: 'u-B' })
    ).resolves.toBeUndefined()
    expect(recordAccessDenial).not.toHaveBeenCalled()
    expect(logServerError).toHaveBeenCalledWith('hidden_row_denial_skip', expect.any(Error))
  })

  it('SUPABASE_SERVICE_ROLE_KEY が無い環境では何もしない', async () => {
    delete process.env.SUPABASE_SERVICE_ROLE_KEY
    const m = await loadModule()
    await m.recordHiddenRowDenial({ table: 'facilities', id: 'fac-A', actorId: 'u-B' })
    expect(createClient).not.toHaveBeenCalled()
    expect(recordAccessDenial).not.toHaveBeenCalled()
  })

  it('記録側（recordAccessDenial）が throw しても飲み込む', async () => {
    maybeSingle.mockResolvedValue({ data: { id: 'fac-A' }, error: null })
    recordAccessDenial.mockRejectedValue(new Error('rpc down'))
    const m = await loadModule()
    await expect(
      m.recordHiddenRowDenial({ table: 'facilities', id: 'fac-A', actorId: 'u-B' })
    ).resolves.toBeUndefined()
  })
})
