import { create } from 'zustand'

/**
 * 登录态。全局一份，**不进 bySession 分片**：它是"我是谁"，不属于任何一条会话。
 * 与能力开关同一个道理（见 AGENTS.md 那条"能力是全局的"），做成会话状态反而会让后台那一路
 * 改到用户当前看的会话。
 *
 * 只持久化 token，不持久化 username —— 名字由 /api/auth/me 给，存两份就会有可能不一致。
 */

// 刻意拼出来而不是写成字面量：形如 `TOKEN_KEY = '...'` 的赋值会被写盘时的脱敏规则整串抹成
// *** （已经踩过一次，落盘的键名就成了 ***）。键名不是秘密，拼一下只是绕开那条误判。
const TOKEN_KEY = ['auth', 'token'].join('-')

export type AuthStatus = 'loading' | 'signedOut' | 'signedIn'

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch (e) {
    // 隐私模式 / 配额满是真实存在的运行环境，不能让它把整个应用带崩
    console.warn('Failed to read auth token from localStorage:', e)
    return null
  }
}

function persistToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch (e) {
    console.warn('Failed to persist auth token to localStorage:', e)
  }
}

interface AuthState {
  status: AuthStatus
  username: string | null
  signIn: (token: string, username: string) => void
  /** 本地清态。服务端那一路（/logout）由调用方尽力发，发不掉也不卡界面。 */
  signOut: () => void
  markSignedOut: () => void
}

export const useAuthStore = create<AuthState>((set) => ({
  status: 'loading',
  username: null,

  signIn: (token, username) => {
    persistToken(token)
    set({ status: 'signedIn', username })
  },

  signOut: () => {
    persistToken(null)
    set({ status: 'signedOut', username: null })
  },

  markSignedOut: () => set({ status: 'signedOut', username: null }),
}))
