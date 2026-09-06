import { create } from 'zustand'
import type { Message } from '../llm/types'
import { runAgentLoop } from '../agent/runAgentLoop'
import type { AgentProgress } from '../agent/types'

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  progress: AgentProgress | null
  sendMessage: (text: string) => void
  abort: () => void
}

let abortController: AbortController | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,
  progress: null,

  sendMessage: async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || get().isStreaming) return

    const userMsg: Message = { role: 'user', content: trimmed }

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      progress: null,
    }))

    abortController = new AbortController()
    const signal = abortController.signal

    try {
      const allMessages = get().messages.filter((m) => m.content !== '')

      await runAgentLoop(allMessages, {
        signal,
        onProgress: (progress) => {
          set({ progress })
        },
      })
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
