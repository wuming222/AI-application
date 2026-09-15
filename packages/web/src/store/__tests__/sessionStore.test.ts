import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../api/sessions', () => ({
  fetchSessions: vi.fn(async () => []),
  createSession: vi.fn(async () => ({
    id: 'brand-new',
    title: '新对话',
    created_at: '2026-09-15T00:00:00.000Z',
    updated_at: '2026-09-15T00:00:00.000Z',
  })),
  renameSession: vi.fn(async () => undefined),
  deleteSession: vi.fn(async () => undefined),
  fetchMessages: vi.fn(async () => []),
  saveMessages: vi.fn(async () => undefined),
  fetchWorkspace: vi.fn(async () => ({})),
  saveWorkspace: vi.fn(async () => undefined),
  generateTitle: vi.fn(async () => '自动标题'),
}))

import * as api from '../../api/sessions'
import { useSessionStore } from '../sessionStore'
import { useChatStore } from '../chatStore'
import { useWorkspaceStore } from '../workspaceStore'
import type { Message } from '../../llm/types'

const USER_MSG: Message = { role: 'user', content: '帮我做个页面' }

function setState(opts: {
  session: string | null
  chat?: { sessionId: string | null; messages: Message[] }
  workspace?: { sessionId: string | null; files: Record<string, string> }
}) {
  useSessionStore.setState({
    currentSessionId: opts.session,
    sessions: opts.session
      ? [{ id: opts.session, title: '会话', created_at: '', updated_at: '' }]
      : [],
  })
  useChatStore.setState({
    messages: opts.chat?.messages ?? [],
    messagesSessionId: opts.chat?.sessionId ?? opts.session,
  })
  useWorkspaceStore.setState({
    currentSessionId: opts.workspace?.sessionId ?? opts.session,
    filesBySession: opts.workspace?.files
      ? { [opts.workspace.sessionId ?? (opts.session as string)]: opts.workspace.files }
      : {},
  })
}

describe('createOrReuseSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useChatStore.setState({ composerFocusTick: 0, isStreaming: false, progress: null })
  })

  it('当前会话没有任何内容时复用，不发新建请求', async () => {
    setState({ session: 's1', chat: { sessionId: 's1', messages: [] }, workspace: { sessionId: 's1', files: {} } })

    const id = await useSessionStore.getState().createOrReuseSession()

    expect(id).toBe('s1')
    expect(api.createSession).not.toHaveBeenCalled()
  })

  it('复用会把焦点送回输入框', async () => {
    setState({ session: 's1' })

    await useSessionStore.getState().createOrReuseSession()

    expect(useChatStore.getState().composerFocusTick).toBe(1)
  })

  it('已有消息时正常新建', async () => {
    setState({ session: 's1', chat: { sessionId: 's1', messages: [USER_MSG] } })

    const id = await useSessionStore.getState().createOrReuseSession()

    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(id).toBe('brand-new')
  })

  it('没有消息但已有生成文件时也算有内容，走新建', async () => {
    setState({
      session: 's1',
      chat: { sessionId: 's1', messages: [] },
      workspace: { sessionId: 's1', files: { 'index.html': '<html></html>' } },
    })

    const id = await useSessionStore.getState().createOrReuseSession()

    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(id).toBe('brand-new')
  })

  it('消息还属于上一条会话时（切换未完成）不复用', async () => {
    setState({ session: 's2', chat: { sessionId: 's1', messages: [] }, workspace: { sessionId: 's1', files: {} } })

    const id = await useSessionStore.getState().createOrReuseSession()

    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(id).toBe('brand-new')
  })

  it('没有当前会话时新建', async () => {
    setState({ session: null, chat: { sessionId: null, messages: [] } })

    const id = await useSessionStore.getState().createOrReuseSession()

    expect(api.createSession).toHaveBeenCalledTimes(1)
    expect(id).toBe('brand-new')
  })
})
