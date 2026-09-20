import type { Message } from '../llm/types'
import { authFetch } from './auth'

const BASE = import.meta.env.VITE_API_BASE_URL || ''

export interface Session {
  id: string
  title: string
  created_at: string
  updated_at: string
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  // 先展开 options 再合 headers：原来 `headers: {...}, ...options` 的写法会让调用方传的
  // headers 把 Content-Type 整个替换掉。凭证由 authFetch 加，这里只管业务头。
  const res = await authFetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    },
  })
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`)
  return res.json()
}

export async function fetchSessions(): Promise<Session[]> {
  const data = await request<{ sessions: Session[] }>('/api/sessions')
  return data.sessions
}

export async function createSession(title?: string): Promise<Session> {
  return request<Session>('/api/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export async function renameSession(id: string, title: string): Promise<Session> {
  return request<Session>(`/api/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  })
}

export async function deleteSession(id: string): Promise<void> {
  await request(`/api/sessions/${id}`, { method: 'DELETE' })
}

export async function fetchMessages(sessionId: string): Promise<Message[]> {
  const data = await request<{ messages: Message[] }>(`/api/sessions/${sessionId}/messages`)
  return data.messages
}

export async function saveMessages(sessionId: string, messages: Message[]): Promise<void> {
  await request(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    body: JSON.stringify(messages),
  })
}

export async function fetchWorkspace(sessionId: string): Promise<Record<string, string>> {
  const data = await request<{ files: Record<string, string> }>(`/api/sessions/${sessionId}/workspace`)
  return data.files
}

export async function saveWorkspace(sessionId: string, files: Record<string, string>): Promise<void> {
  await request(`/api/sessions/${sessionId}/workspace`, {
    method: 'PUT',
    body: JSON.stringify({ files }),
  })
}

export async function generateTitle(message: string): Promise<string> {
  const data = await request<{ title: string }>('/api/llm/title', {
    method: 'POST',
    body: JSON.stringify({ message }),
  })
  return data.title
}
