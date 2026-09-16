import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 'brand-new', title: '新对话', created_at: '', updated_at: '' })),
  renameSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  fetchMessages: vi.fn(async () => [{ role: 'user', content: '服务端旧消息' }]),
  saveMessages: vi.fn(async () => undefined),
  fetchWorkspace: vi.fn(async () => ({ 'index.html': '<html>server</html>' })),
  saveWorkspace: vi.fn(async () => undefined),
  generateTitle: vi.fn(async () => '自动标题'),
}))

vi.mock('antd', () => ({
  message: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

// 可控的假循环：测试里手动决定它何时结束、结束后返回什么
let loopResolve: ((v: { finalText: string; updatedMessages: unknown[] }) => void) | null = null
let lastLoopArgs: { messages: unknown[]; sessionId: string } | null = null

vi.mock('../../agent/runAgentLoop', () => ({
  runAgentLoop: vi.fn((messages: unknown[], options: { sessionId: string }) => {
    lastLoopArgs = { messages, sessionId: options.sessionId }
    return new Promise((resolve) => {
      loopResolve = resolve
    })
  }),
}))

import * as api from '../../api/sessions'
import { message as antdMessage } from 'antd'
import { useChatStore } from '../chatStore'
import { useSessionStore } from '../sessionStore'
import { useWorkspaceStore } from '../workspaceStore'

function openSession(id: string) {
  useSessionStore.setState({
    currentSessionId: id,
    sessions: [{ id, title: id, created_at: '', updated_at: '' }],
  })
  useWorkspaceStore.setState({ currentSessionId: id })
}

beforeEach(() => {
  vi.clearAllMocks()
  loopResolve = null
  lastLoopArgs = null
  useChatStore.setState({ bySession: {}, streamSessionId: null, composerFocusTick: 0 })
  useWorkspaceStore.setState({ filesBySession: {}, currentSessionId: null })
})

describe('chatStore 按会话隔离', () => {
  it('生成中切到别的会话，切过去的那条不被写入，跑完只回到原会话', async () => {
    openSession('A')
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()

    openSession('B')
    await useChatStore.getState().loadSession('B')

    // B 是分片模型下的另一条会话：不该看到 A 的进行中状态
    expect(useChatStore.getState().bySession['B']?.isStreaming).toBe(false)
    expect(useChatStore.getState().bySession['A']?.isStreaming).toBe(true)
    expect(api.saveMessages).not.toHaveBeenCalled()

    loopResolve?.({ finalText: 'done', updatedMessages: [{ role: 'assistant', content: 'A 的回复' }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(useChatStore.getState().bySession['A']?.messages).toEqual([{ role: 'assistant', content: 'A 的回复' }])
    expect(useChatStore.getState().bySession['B']?.messages).toEqual([{ role: 'user', content: '服务端旧消息' }])
    expect(api.saveMessages).toHaveBeenCalledTimes(1)
    expect(vi.mocked(api.saveMessages).mock.calls[0][0]).toBe('A')
    expect(useChatStore.getState().streamSessionId).toBeNull()
  })

  it('切回仍在生成的会话，不会被服务端数据覆盖', async () => {
    openSession('A')
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()
    const inFlight = useChatStore.getState().bySession['A'].messages

    await useChatStore.getState().loadSession('A')

    expect(useChatStore.getState().bySession['A'].messages).toBe(inFlight)
  })

  it('在 B 上发送时，上下文只含 B 的历史，且先打断 A 并回滚它的分片', async () => {
    openSession('A')
    useChatStore.setState({ bySession: { A: { messages: [{ role: 'user', content: 'A1' }], progress: null, isStreaming: false } } })
    useChatStore.getState().sendMessage('A 的新问题')
    await Promise.resolve()
    expect(useChatStore.getState().bySession['A'].messages).toHaveLength(2)

    openSession('B')
    useChatStore.setState((s) => ({
      bySession: { ...s.bySession, B: { messages: [{ role: 'user', content: 'B1' }], progress: null, isStreaming: false } },
    }))
    useChatStore.getState().sendMessage('B 的新问题')
    await Promise.resolve()

    // A 回到本轮开始前，并给出可见提示
    expect(useChatStore.getState().bySession['A'].messages).toEqual([{ role: 'user', content: 'A1' }])
    expect(useChatStore.getState().bySession['A'].isStreaming).toBe(false)
    expect(antdMessage.info).toHaveBeenCalledWith('已中断另一条会话的生成')
    // 发给模型的历史只有 B 的
    expect(lastLoopArgs?.sessionId).toBe('B')
    expect(lastLoopArgs?.messages.map((m) => (m as { content: string }).content)).toEqual(['B1', 'B 的新问题'])
    expect(useChatStore.getState().streamSessionId).toBe('B')
  })

  it('A 被顶替后即使跑完也不写回、不落库', async () => {
    openSession('A')
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()
    const staleResolve = loopResolve

    openSession('B')
    useChatStore.getState().sendMessage('B 的问题')
    await Promise.resolve()

    staleResolve?.({ finalText: 'stale', updatedMessages: [{ role: 'assistant', content: '过期结果' }] })
    await Promise.resolve()
    await Promise.resolve()

    // 被打断的一路整轮回滚（连刚输入的那条一起），与"整轮才落库"一致
    expect(useChatStore.getState().bySession['A'].messages).toEqual([])
    expect(useChatStore.getState().bySession['A'].isStreaming).toBe(false)
    expect(api.saveMessages).not.toHaveBeenCalled()
    expect(api.saveWorkspace).not.toHaveBeenCalled()
  })

  it('工具与工作区读写按发起会话定向，不落到当前打开的会话', async () => {
    openSession('A')
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()

    useWorkspaceStore.getState().writeFile('A', 'index.html', '<html>A</html>')
    openSession('B')
    useWorkspaceStore.getState().writeFile('B', 'index.html', '<html>B</html>')

    loopResolve?.({ finalText: 'ok', updatedMessages: [{ role: 'assistant', content: 'A 的回复' }] })
    await Promise.resolve()
    await Promise.resolve()

    const [, savedA] = vi.mocked(api.saveWorkspace).mock.calls[0]
    expect(vi.mocked(api.saveWorkspace).mock.calls[0][0]).toBe('A')
    expect(savedA).toEqual({ 'index.html': '<html>A</html>' })
  })

  it('删除正在生成的会话时先中止', async () => {
    openSession('A')
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()
    expect(useChatStore.getState().streamSessionId).toBe('A')

    await useSessionStore.getState().deleteSession('A')

    expect(useChatStore.getState().streamSessionId).toBeNull()
    expect(useChatStore.getState().bySession['A']).toBeUndefined()
  })
})
