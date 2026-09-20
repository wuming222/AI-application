import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getToken, useAuthStore } from '../authStore'
import { authFetch, authHeaders, voiceWsUrl } from '../../api/auth'

function fakeResponse(status: number) {
  return { status, ok: status < 400, json: async () => ({}) } as unknown as Response
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useAuthStore.setState({ status: 'loading', username: null })
})

describe('authStore', () => {
  it('signIn 落 token 到 localStorage，signOut 清掉', () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    expect(getToken()).toBe('tk-1')
    expect(useAuthStore.getState().status).toBe('signedIn')
    expect(useAuthStore.getState().username).toBe('alice')

    useAuthStore.getState().signOut()
    expect(getToken()).toBeNull()
    expect(useAuthStore.getState().status).toBe('signedOut')
    expect(useAuthStore.getState().username).toBeNull()
  })

  it('只持久化 token，不持久化 username', () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    expect(Object.keys(localStorage)).toEqual(['auth-token'])
  })

  it('localStorage 抛异常时不崩（隐私模式 / 配额满）', () => {
    const original = Storage.prototype.getItem
    Storage.prototype.getItem = () => {
      throw new Error('QuotaExceededError')
    }
    expect(getToken()).toBeNull()
    Storage.prototype.getItem = original
  })
})

describe('authHeaders', () => {
  it('未登录时不加 Authorization', () => {
    expect(authHeaders()).toEqual({})
  })

  it('登录后带上，且保留调用方自己的 header', () => {
    useAuthStore.getState().signIn('tk/+=', 'alice')
    expect(authHeaders({ 'Content-Type': 'application/json' })).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer tk/+=',
    })
  })

  it('接受 Headers 与数组两种形态，不吞掉任何一个', () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    const fromHeaders = authHeaders(new Headers({ 'X-A': '1' }))
    expect(fromHeaders['x-a']).toBe('1')
    expect(fromHeaders.Authorization).toBe('Bearer tk-1')

    const fromPairs = authHeaders([['X-B', '2']])
    expect(fromPairs['X-B']).toBe('2')
    expect(fromPairs.Authorization).toBe('Bearer tk-1')
  })
})

describe('authFetch', () => {
  it('带上 Authorization 发请求', async () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => fakeResponse(200))
    vi.stubGlobal('fetch', fetchMock)

    await authFetch('/api/sessions')
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer tk-1' })
    vi.unstubAllGlobals()
  })

  it('401 就地清登录态，但不重发请求', async () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    const fetchMock = vi.fn(async () => fakeResponse(401))
    vi.stubGlobal('fetch', fetchMock)

    const res = await authFetch('/api/sessions')
    expect(res.status).toBe(401)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(useAuthStore.getState().status).toBe('signedOut')
    expect(getToken()).toBeNull()
    vi.unstubAllGlobals()
  })

  it('404 / 429 不动登录态（那是权限与额度问题，不是没登录）', async () => {
    useAuthStore.getState().signIn('tk-1', 'alice')
    for (const status of [403, 404, 429, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(status)))
      await authFetch('/api/sessions')
      expect(useAuthStore.getState().status).toBe('signedIn')
    }
    vi.unstubAllGlobals()
  })
})

describe('voiceWsUrl', () => {
  it('浏览器 WS 带不了 header，所以 token 走 query 并做 URL 编码', () => {
    useAuthStore.getState().signIn('tk/+=', 'alice')
    const url = voiceWsUrl()
    expect(url).toContain('/api/voice/ws?token=tk%2F%2B%3D')
    expect(url).not.toContain('tk/+=')
  })

  it('未登录时不拼出 token=undefined 这种脏地址', () => {
    expect(voiceWsUrl()).not.toContain('token=')
  })
})
