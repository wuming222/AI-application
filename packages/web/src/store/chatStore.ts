import { create } from 'zustand'
import type { Message } from '../llm/types'
import { streamChat } from '../llm/router'

interface ChatState {
  messages: Message[]
  isStreaming: boolean
  sendMessage: (text: string) => void
  abort: () => void
}

let abortController: AbortController | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  messages: [],
  isStreaming: false,

  sendMessage: async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || get().isStreaming) return

    const userMsg: Message = { role: 'user', content: trimmed }
    const assistantMsg: Message = { role: 'assistant', content: '' }

    set((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
      isStreaming: true,
    }))

    abortController = new AbortController()
    const signal = abortController.signal

    try {
      const allMessages = get().messages.filter((m) => m.content !== '')
      let accumulated = ''

      for await (const chunk of streamChat(allMessages, signal)) {
        if (signal.aborted) break
        accumulated += chunk.delta
        set((s) => {
          const updated = [...s.messages]
          updated[updated.length - 1] = {
            role: 'assistant',
            content: accumulated,
          }
          return { messages: updated }
        })
        if (chunk.done) break
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Stream error:', err)
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
