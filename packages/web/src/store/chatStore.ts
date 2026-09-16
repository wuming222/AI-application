import { create } from 'zustand'
import { message as antdMessage } from 'antd'
import type { Message } from '../llm/types'
import { runAgentLoop } from '../agent/runAgentLoop'
import type { AgentProgress } from '../agent/types'
import { useSessionStore } from './sessionStore'
import { useWorkspaceStore } from './workspaceStore'
import { fetchMessages, saveMessages, fetchWorkspace, saveWorkspace, generateTitle } from '../api/sessions'

export interface ChatSlice {
  messages: Message[]
  progress: AgentProgress | null
  isStreaming: boolean
}

const EMPTY_SLICE: ChatSlice = { messages: [], progress: null, isStreaming: false }

interface ChatState {
  // 每条会话一份状态。以前是全局单槽：切走之后仍在跑的循环会把旧会话的消息和进度
  // 写进当前视图，收尾时整片盖掉 —— 界面是多会话的，状态不能再是单槽。
  bySession: Record<string, ChatSlice>
  // 全局最多一路生成，记住它属于哪条会话。
  streamSessionId: string | null
  composerFocusTick: number
  sliceFor: (sessionId: string | null) => ChatSlice
  isEmptySession: (sessionId: string) => boolean
  sendMessage: (text: string, images?: string[]) => void
  abortStream: () => void
  requestComposerFocus: () => void
  loadSession: (sessionId: string) => Promise<void>
  dropSession: (sessionId: string) => void
  initFirstSession: () => Promise<void>
}

let abortController: AbortController | null = null
// 代际标记：被顶替 / 被中止 / 会话已删的那一路，不许再写回 store 或落库
let streamSeq = 0
let streamRollback: Message[] | null = null

export const useChatStore = create<ChatState>((set, get) => ({
  bySession: {},
  streamSessionId: null,
  composerFocusTick: 0,

  sliceFor: (sessionId) => (sessionId ? (get().bySession[sessionId] ?? EMPTY_SLICE) : EMPTY_SLICE),

  requestComposerFocus: () => set((s) => ({ composerFocusTick: s.composerFocusTick + 1 })),

  isEmptySession: (sessionId) => {
    if (get().streamSessionId === sessionId) return false
    if ((get().bySession[sessionId]?.messages.length ?? 0) > 0) return false
    return Object.keys(useWorkspaceStore.getState().filesFor(sessionId)).length === 0
  },

  loadSession: async (sessionId: string) => {
    const streamingHere = get().streamSessionId === sessionId
    try {
      const [messages, files] = await Promise.all([
        fetchMessages(sessionId),
        fetchWorkspace(sessionId),
      ])
      // 这一路还在跑：服务端只有上一轮的数据，覆盖会抹掉进行中的消息与文件
      if (streamingHere) {
        useWorkspaceStore.getState().setCurrentSession(sessionId)
        return
      }
      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: { messages, progress: null, isStreaming: false },
        },
      }))
      useWorkspaceStore.getState().setCurrentSession(sessionId)
      useWorkspaceStore.getState().loadWorkspace(sessionId, files)
    } catch (err) {
      console.error('Failed to load session:', err)
    }
  },

  dropSession: (sessionId) => {
    set((s) => {
      const rest = { ...s.bySession }
      delete rest[sessionId]
      return { bySession: rest }
    })
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

  sendMessage: async (text: string, images?: string[]) => {
    const trimmed = text.trim()
    if (!trimmed && !images?.length) return

    const sessionId = useSessionStore.getState().currentSessionId
    if (!sessionId) return

    const busyWith = get().streamSessionId
    if (busyWith && busyWith !== sessionId) {
      // 同时只允许一路：在别的会话发送时先打断那一路，让它自己的会话回到本轮之前
      get().abortStream()
      antdMessage.info('已中断另一条会话的生成')
    }
    if (get().bySession[sessionId]?.isStreaming) return

    const prevMessages = get().bySession[sessionId]?.messages ?? []
    const userMsg: Message = { role: 'user', content: trimmed, ...(images?.length ? { images } : {}) }
    const history = [...prevMessages, userMsg]
    const seq = ++streamSeq
    streamRollback = prevMessages

    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: { messages: history, progress: null, isStreaming: true },
      },
      streamSessionId: sessionId,
    }))

    abortController = new AbortController()
    const signal = abortController.signal

    try {
      const result = await runAgentLoop(history, {
        signal,
        sessionId,
        onProgress: (progress) => {
          if (streamSeq !== seq) return
          set((s) => ({
            bySession: {
              ...s.bySession,
              [sessionId]: { ...(s.bySession[sessionId] ?? EMPTY_SLICE), progress },
            },
          }))
        },
      })

      // 这一路已被顶替或中止：结果作废，既不写回视图也不落库
      if (streamSeq !== seq) return

      set((s) => ({
        bySession: {
          ...s.bySession,
          [sessionId]: { messages: result.updatedMessages, progress: null, isStreaming: false },
        },
        streamSessionId: null,
      }))
      streamRollback = null
      abortController = null

      const newMessages = result.updatedMessages.slice(prevMessages.length)
      if (newMessages.length > 0) {
        saveMessages(sessionId, newMessages).catch((err) =>
          console.error('Failed to persist messages:', err),
        )
      }
      saveWorkspace(sessionId, useWorkspaceStore.getState().filesFor(sessionId)).catch((err) =>
        console.error('Failed to persist workspace:', err),
      )

      if (prevMessages.length === 0) {
        generateTitle(trimmed)
          .then((title) => {
            useSessionStore.getState().renameSession(sessionId, title)
          })
          .catch(() => {})
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Agent loop error:', err)
        antdMessage.error('请求失败，请检查网络连接后重试')
      }
    } finally {
      if (streamSeq === seq) {
        abortController = null
        streamRollback = null
        set((s) => ({
          bySession: {
            ...s.bySession,
            [sessionId]: { ...(s.bySession[sessionId] ?? EMPTY_SLICE), isStreaming: false },
          },
          streamSessionId: null,
        }))
      }
    }
  },

  abortStream: () => {
    const sessionId = get().streamSessionId
    streamSeq++ // 让这一路后续所有写入作废
    abortController?.abort()
    abortController = null
    const rollback = streamRollback
    streamRollback = null
    if (!sessionId) return
    set((s) => ({
      bySession: {
        ...s.bySession,
        [sessionId]: {
          messages: rollback ?? (s.bySession[sessionId]?.messages ?? []),
          progress: null,
          isStreaming: false,
        },
      },
      streamSessionId: null,
    }))
  },
}))
