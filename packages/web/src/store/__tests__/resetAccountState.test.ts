import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({ id: 'new', title: '新对话', created_at: '', updated_at: '' })),
  renameSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  fetchMessages: vi.fn(async () => []),
  saveMessages: vi.fn(async () => undefined),
  fetchWorkspace: vi.fn(async () => ({})),
  saveWorkspace: vi.fn(async () => undefined),
  generateTitle: vi.fn(async () => '自动标题'),
}))

vi.mock('antd', () => ({
  message: { info: vi.fn(), error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))

let loopResolve: ((v: { finalText: string; updatedMessages: unknown[] }) => void) | null = null

vi.mock('../../agent/runAgentLoop', () => ({
  runAgentLoop: vi.fn(() => new Promise((resolve) => { loopResolve = resolve })),
}))

import * as api from '../../api/sessions'
import { useChatStore } from '../chatStore'
import { useSessionStore } from '../sessionStore'
import { useWorkspaceStore } from '../workspaceStore'
import { resetAccountState } from '../resetAccountState'

function seedAccountA() {
  useSessionStore.setState({
    sessions: [
      { id: 'A1', title: 'A 的会话', created_at: '', updated_at: '' },
      { id: 'A2', title: 'A 的另一条', created_at: '', updated_at: '' },
    ],
    currentSessionId: 'A1',
    isLoading: false,
  })
  useChatStore.setState({
    bySession: {
      A1: { messages: [{ role: 'user', content: 'A 的私密需求' }], progress: null, isStreaming: false },
      A2: { messages: [], progress: null, isStreaming: false },
    },
    streamSessionId: null,
  })
  useWorkspaceStore.setState({
    filesBySession: { A1: { 'index.html': '<html>A 的代码</html>' } },
    currentSessionId: 'A1',
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  loopResolve = null
})

describe('resetAccountState', () => {
  it('三个 store 里属于会话的数据全部清掉', () => {
    seedAccountA()
    resetAccountState()

    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().currentSessionId).toBeNull()
    expect(useChatStore.getState().bySession).toEqual({})
    expect(useWorkspaceStore.getState().filesBySession).toEqual({})
    expect(useWorkspaceStore.getState().currentSessionId).toBeNull()
  })

  it('A 的消息与文件不会在 B 登录后还在内存里', () => {
    seedAccountA()
    resetAccountState()
    expect(JSON.stringify(useChatStore.getState().bySession)).not.toContain('A 的私密需求')
    expect(JSON.stringify(useWorkspaceStore.getState().filesBySession)).not.toContain('A 的代码')
  })

  it('生成进行到一半就登出：中止、结果作废、不落库', async () => {
    seedAccountA()
    useSessionStore.setState({ currentSessionId: 'A1' })
    useChatStore.getState().sendMessage('A 的问题')
    await Promise.resolve()
    expect(useChatStore.getState().streamSessionId).toBe('A1')

    resetAccountState()
    expect(useChatStore.getState().streamSessionId).toBeNull()

    // 登出之后这一路才跑完：结果不许写回，也不许 PUT 到任何一条会话
    loopResolve?.({ finalText: 'done', updatedMessages: [{ role: 'assistant', content: '迟到结果' }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(useChatStore.getState().bySession).toEqual({})
    expect(api.saveMessages).not.toHaveBeenCalled()
    expect(api.saveWorkspace).not.toHaveBeenCalled()
  })
})
