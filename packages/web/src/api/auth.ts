import { getToken, useAuthStore } from '../store/authStore'

/**
 * 前端所有对后端取数的**统一出口**。现有 6 处 fetch 与 1 处 WebSocket 全部走这里，
 * 目的是让"带凭证"这件事只有一个判据处 —— 各调用点自己拼 Authorization 迟早会漏一处。
 *
 * 401 就地清登录态。刻意不在这里重发请求：登录过期之后界面要回到登录卡，
 * 而不是悄悄改状态再试一次（用户会看到数据凭空变了却不知道为什么）。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''

export function authHeaders(extra?: HeadersInit): Record<string, string> {
  // 调用方传的 headers 可能是 Headers / 数组 / 普通对象，统一收成普通对象再合。
  const merged: Record<string, string> = {}
  if (extra) {
    if (extra instanceof Headers) {
      extra.forEach((v, k) => { merged[k] = v })
    } else if (Array.isArray(extra)) {
      for (const [k, v] of extra as [string, string][]) merged[k] = v
    } else {
      Object.assign(merged, extra)
    }
  }
  const token = getToken()
  if (token) merged.Authorization = `Bearer ${token}`
  return merged
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(input, { ...init, headers: authHeaders(init.headers) })
  if (res.status === 401) {
    // 只清本地。服务端那条 token 已经自己判死了，再打 /logout 是多余的一次往返。
    useAuthStore.getState().signOut()
  }
  return res
}

/**
 * WebSocket 带不了自定义 header（浏览器限制），所以 token 只能挂在 query 上。
 * 代价是它会出现在 URL 里 —— 当前后端不打访问日志，接受；上生产要留日志时得改成一次性 ticket。
 */
export function voiceWsUrl(): string {
  const base = BASE.replace(/^http/, 'ws') + '/api/voice/ws'
  const token = getToken()
  if (!token) return base
  return `${base}?token=${encodeURIComponent(token)}`
}

export interface AuthPayload {
  token: string
  user: { id: string; username: string }
}

async function postAuth(path: string, body: { username: string; password: string }) {
  const res = await authFetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data?.detail || `请求失败（${res.status}）`)
  return data as AuthPayload
}

export async function register(username: string, password: string): Promise<AuthPayload> {
  return postAuth('/api/auth/register', { username, password })
}

export async function login(username: string, password: string): Promise<AuthPayload> {
  return postAuth('/api/auth/login', { username, password })
}

export async function logout(): Promise<void> {
  // 发不掉也无所谓：本地已经清了，服务端那条 token 会随过期自然失效。
  await authFetch(`${BASE}/api/auth/logout`, { method: 'POST' }).catch(() => undefined)
}

export async function fetchMe(): Promise<{ id: string; username: string }> {
  const res = await authFetch(`${BASE}/api/auth/me`)
  if (!res.ok) throw new Error('未登录或登录已过期')
  return res.json()
}

/**
 * 启动时用本地 token 换一次身份。StrictMode 下会跑两遍，两次都只是只读 /me，幂等。
 */
export async function bootstrapAuth(): Promise<void> {
  const store = useAuthStore.getState()
  const token = getToken()
  if (!token) {
    store.markSignedOut()
    return
  }
  try {
    const me = await fetchMe()
    store.signIn(token, me.username)
  } catch {
    store.signOut()
  }
}
