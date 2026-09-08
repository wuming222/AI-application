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
      // 空 content 的 assistant 消息承载 tool_calls，过滤会拆散 tool 配对；由 provider 层转换时处理
      const allMessages = get().messages

      const result = await runAgentLoop(allMessages, {
        signal,
        onProgress: (progress) => {
          set({ progress })
        },
      })

      // Update messages with assistant replies from agent loop
      set({ messages: result.updatedMessages })
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
