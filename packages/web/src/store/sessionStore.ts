import { create } from 'zustand'
import type { Session } from '../api/sessions'
import {
  fetchSessions,
  createSession as apiCreateSession,
  renameSession as apiRenameSession,
  deleteSession as apiDeleteSession,
} from '../api/sessions'
import { useChatStore } from './chatStore'
import { useWorkspaceStore } from './workspaceStore'

interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  isLoading: boolean
  loadSessions: () => Promise<void>
  createSession: (title?: string) => Promise<string>
  switchSession: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
}

export const useSessionStore = create<SessionState>((set, get) => ({
  sessions: [],
  currentSessionId: null,
  isLoading: false,

  loadSessions: async () => {
    set({ isLoading: true })
    try {
      const sessions = await fetchSessions()
      set({ sessions, isLoading: false })
    } catch (err) {
      console.error('Failed to load sessions:', err)
      set({ isLoading: false })
    }
  },

  createSession: async (title?: string) => {
    const session = await apiCreateSession(title)
    set((s) => ({
      sessions: [session, ...s.sessions],
      currentSessionId: session.id,
    }))
    useWorkspaceStore.getState().setCurrentSession(session.id)
    useChatStore.getState().loadSession(session.id)
    return session.id
  },

  switchSession: (id: string) => {
    set({ currentSessionId: id })
    useChatStore.getState().loadSession(id)
  },

  deleteSession: async (id: string) => {
    await apiDeleteSession(id)
    set((s) => {
      const sessions = s.sessions.filter((sess) => sess.id !== id)
      const currentSessionId =
        s.currentSessionId === id ? (sessions[0]?.id ?? null) : s.currentSessionId
      return { sessions, currentSessionId }
    })
    const newCurrent = useSessionStore.getState().currentSessionId
    if (newCurrent) {
      useChatStore.getState().loadSession(newCurrent)
    } else {
      useChatStore.setState({ messages: [] })
      useWorkspaceStore.getState().setCurrentSession('')
    }
  },

  renameSession: async (id: string, title: string) => {
    await apiRenameSession(id, title)
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === id ? { ...sess, title } : sess,
      ),
    }))
  },
}))
