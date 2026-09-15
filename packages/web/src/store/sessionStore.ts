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
  createOrReuseSession: () => Promise<string>
  switchSession: (id: string) => void
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
  reorderSessions: (fromIndex: number, toIndex: number) => void
}

export const useSessionStore = create<SessionState>((set) => ({
  sessions: [],
  currentSessionId: null,
  isLoading: false,

  loadSessions: async () => {
    set({ isLoading: true })
    try {
      const sessions = await fetchSessions()
      
      // Load saved order from localStorage
      try {
        const savedOrder = localStorage.getItem('session-order')
        if (savedOrder) {
          const orderIds: string[] = JSON.parse(savedOrder)
          // Sort sessions according to saved order
          sessions.sort((a, b) => {
            const indexA = orderIds.indexOf(a.id)
            const indexB = orderIds.indexOf(b.id)
            // If both are in saved order, use that order
            if (indexA !== -1 && indexB !== -1) return indexA - indexB
            // If only one is in saved order, prioritize it
            if (indexA !== -1) return -1
            if (indexB !== -1) return 1
            // Otherwise keep original order
            return 0
          })
        }
      } catch (e) {
        console.warn('Failed to read session order from localStorage:', e)
      }
      
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

  // 停在一条没有任何内容的会话上再点新建，重复建只会堆出空会话
  createOrReuseSession: async (): Promise<string> => {
    const { currentSessionId, createSession } = useSessionStore.getState()
    const chat = useChatStore.getState()
    const workspace = useWorkspaceStore.getState()
    const loadedForCurrent =
      !!currentSessionId &&
      chat.messagesSessionId === currentSessionId &&
      workspace.currentSessionId === currentSessionId
    if (loadedForCurrent && chat.messages.length === 0 && Object.keys(workspace.getCurrentFiles()).length === 0) {
      chat.requestComposerFocus()
      return currentSessionId
    }
    return createSession()
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
      
      // Update saved order after deletion
      try {
        const savedOrder = localStorage.getItem('session-order')
        if (savedOrder) {
          const orderIds: string[] = JSON.parse(savedOrder).filter((sid: string) => sid !== id)
          localStorage.setItem('session-order', JSON.stringify(orderIds))
        }
      } catch (e) {
        console.warn('Failed to update session order in localStorage:', e)
      }
      
      return { sessions, currentSessionId }
    })
    const newCurrent = useSessionStore.getState().currentSessionId
    if (newCurrent) {
      useChatStore.getState().loadSession(newCurrent)
    } else {
      useChatStore.setState({ messages: [], messagesSessionId: null })
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

  reorderSessions: (fromIndex: number, toIndex: number) => {
    set((s) => {
      const sessions = [...s.sessions]
      const [removed] = sessions.splice(fromIndex, 1)
      sessions.splice(toIndex, 0, removed)
      
      // Save new order to localStorage
      try {
        const orderIds = sessions.map((sess) => sess.id)
        localStorage.setItem('session-order', JSON.stringify(orderIds))
      } catch (e) {
        console.warn('Failed to save session order to localStorage:', e)
      }
      
      return { sessions }
    })
  },
}))
