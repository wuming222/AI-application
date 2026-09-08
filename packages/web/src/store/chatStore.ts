import { create } from 'zustand'
import type { Message } from '../llm/types'
import { runAgentLoop } from '../agent/runAgentLoop'
import type { AgentProgress } from '../agent/types'
import { useSessionStore } from './sessionStore'
import { useWorkspaceStore } from './workspaceStore'
import { fetchMessages, saveMessages, fetchWorkspace, saveWorkspace, generateTitle } from '../api/sessions'

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  progress: AgentProgress | null
  sendMessage: (text: string) => void
  abort: () => void
  loadSession: (sessionId: string) => Promise<void>
  initFirstSession: () => Promise<void>
}

let abortController: AbortController | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  progress: null,

  loadSession: async (sessionId: string) => {
    try {
      const [messages, files] = await Promise.all([
        fetchMessages(sessionId),
        fetchWorkspace(sessionId),
      ])
      set({ messages, progress: null })
      useWorkspaceStore.getState().setCurrentSession(sessionId)
      useWorkspaceStore.getState().loadWorkspace(sessionId, files)
    } catch (err) {
      console.error('Failed to load session:', err)
    }
  },

  initFirstSession: async () => {
    const { sessions, loadSessions, createSession } = useSessionStore.getState()
    if (sessions.length === 0) {
      await loadSessions()
    }
    const currentSessions = useSessionStore.getState().sessions
    let sessionId: string
    if (currentSessions.length > 0) {
      sessionId = currentSessions[0].id
    } else {
      sessionId = await createSession()
    }
    useSessionStore.getState().switchSession(sessionId)
    await get().loadSession(sessionId)
  },

  sendMessage: async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || get().isStreaming) return

    const sessionId = useSessionStore.getState().currentSessionId
    if (!sessionId) return

    const userMsg: Message = { role: 'user', content: trimmed }
    const prevCount = get().messages.length

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      progress: null,
    }))

    abortController = new AbortController()
    const signal = abortController.signal

    try {
      const allMessages = get().messages

      const result = await runAgentLoop(allMessages, {
        signal,
        onProgress: (progress) => {
          set({ progress })
        },
      })

      set({ messages: result.updatedMessages })

      const newMessages = result.updatedMessages.slice(prevCount)
      if (newMessages.length > 0) {
        saveMessages(sessionId, newMessages).catch((err) =>
          console.error('Failed to persist messages:', err),
        )
      }

      const files = useWorkspaceStore.getState().getCurrentFiles()
      saveWorkspace(sessionId, files).catch((err) =>
        console.error('Failed to persist workspace:', err),
      )

      if (prevCount === 0) {
        generateTitle(trimmed).then((title) => {
          useSessionStore.getState().renameSession(sessionId, title)
        }).catch(() => {})
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Agent loop error:', err)
      }
    } finally {
      abortController = null
      set({ isStreaming: false })
    }
  },

  abort: () => {
    abortController?.abort()
    set({ isStreaming: false })
  },
}))
