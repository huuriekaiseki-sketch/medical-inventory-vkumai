import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useFacilityRole } from '../useFacilityRole'

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return {
    ok: init.status === undefined || init.status < 400,
    status: init.status ?? 200,
    json: async () => body,
  } as Response
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('useFacilityRole', () => {
  it('取得中はrole=undefined, isLoading=true, canWrite=falseを返す', async () => {
    let resolveFetch: (v: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve })))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    expect(result.current.role).toBeUndefined()
    expect(result.current.isLoading).toBe(true)
    expect(result.current.canWrite).toBe(false)

    resolveFetch(jsonResponse({ role: 'staff' }))
    await waitFor(() => expect(result.current.isLoading).toBe(false))
  })

  it('facilityIdがnull/undefinedの場合、fetchせずrole=nullを返す', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const { result } = renderHook(() => useFacilityRole(null))

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.role).toBeNull()
    expect(result.current.canWrite).toBe(false)
    expect(result.current.isLoading).toBe(false)
  })

  it('adminの場合、canWrite=trueを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ role: 'admin' }))))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    await waitFor(() => expect(result.current.role).toBe('admin'))
    expect(result.current.canWrite).toBe(true)
  })

  it('staffの場合、canWrite=trueを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ role: 'staff' }))))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    await waitFor(() => expect(result.current.role).toBe('staff'))
    expect(result.current.canWrite).toBe(true)
  })

  it('viewerの場合、canWrite=falseを返す(issue #608/#618)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ role: 'viewer' }))))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    await waitFor(() => expect(result.current.role).toBe('viewer'))
    expect(result.current.canWrite).toBe(false)
  })

  it('未所属(role: null)の場合、canWrite=falseを返す', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ role: null }))))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.role).toBeNull()
    expect(result.current.canWrite).toBe(false)
  })

  it('fetch失敗時はrole=nullにフォールバックする(安全側)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ error: 'ng' }, { status: 500 }))))

    const { result } = renderHook(() => useFacilityRole('f-1'))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.role).toBeNull()
    expect(result.current.canWrite).toBe(false)
  })

  it('facilityIdが変わると再取得する', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/facilities/f-1/my-role') return Promise.resolve(jsonResponse({ role: 'viewer' }))
      if (url === '/api/facilities/f-2/my-role') return Promise.resolve(jsonResponse({ role: 'admin' }))
      return Promise.resolve(jsonResponse({ error: 'unexpected' }, { status: 500 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    const { result, rerender } = renderHook(({ facilityId }) => useFacilityRole(facilityId), {
      initialProps: { facilityId: 'f-1' },
    })
    await waitFor(() => expect(result.current.role).toBe('viewer'))

    rerender({ facilityId: 'f-2' })
    await waitFor(() => expect(result.current.role).toBe('admin'))

    expect(fetchMock).toHaveBeenCalledWith('/api/facilities/f-1/my-role')
    expect(fetchMock).toHaveBeenCalledWith('/api/facilities/f-2/my-role')
  })
})
