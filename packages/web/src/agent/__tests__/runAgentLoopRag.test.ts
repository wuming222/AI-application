import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchRagSection = vi.fn()
const streamChat = vi.fn()

// lastUserQuery 是纯函数且**正是被断言的那一路**（检索词必须是用户原话），所以留真身，
// 只把要发 HTTP 的 fetchRagSection 换成假的。整个模块换成哑的会让那条断言自己骗自己。
vi.mock('../providers/rag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../providers/rag')>()),
  fetchRagSection: (...args: unknown[]) => fetchRagSection(...args),
  RAG_SOURCE_ID: 'rag',
}))
// 主循环会 import providers/skills 与 providers/mcp（模块期副作用），这里全部换成哑的，
// 否则一场测试要真去握手 MCP、拉技能目录。
// 注意：vi.mock 的路径是**相对本测试文件**解析的（本文件在 src/agent/__tests__/ 下），
// 所以 src/agent 之外的模块要写 ../../。写错不会报错 —— vitest 只会当作没这个 mock，
// 真的模块继续生效，表现就是单测往外网发请求。
vi.mock('../providers/mcp', () => ({ mcpCapabilitiesReady: () => Promise.resolve() }))
vi.mock('../providers/skills', () => ({ buildSkillIndexSection: () => '' }))
vi.mock('../../llm/router', () => ({ streamChat: (...args: unknown[]) => streamChat(...args) }))
vi.mock('../toolRegistry', () => ({
  registry: {
    getDefinitionsFor: () => [],
    executeDetailed: async () => ({ text: 'ok', isError: false }),
  },
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ filesFor: () => ({}) }) },
}))

import { runAgentLoop } from '../runAgentLoop'

/** 第 1 轮吐一个函数调用逼出第 2 轮，第 2 轮纯文本收尾。 */
function scriptedStream() {
  let call = 0
  return async function* fakeStream() {
    call += 1
    if (call === 1) {
      yield { delta: '', done: false, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } },
      ] }
      return
    }
    yield { delta: '好了', done: true }
  }
}

describe('runAgentLoop 的历史参考注入', () => {
  beforeEach(() => {
    fetchRagSection.mockReset().mockResolvedValue('\n\n## 历史参考\n- 「佛山天气」')
    streamChat.mockReset().mockImplementation(scriptedStream())
  })

  it('多轮生成里只检索一次', async () => {
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5 },
    )
    expect(fetchRagSection).toHaveBeenCalledTimes(1)
  })

  it('检索词是用户那句话，exclude 是发起那条会话', async () => {
    // 必须带 signal：expect.anything() 按设计不匹配 undefined，而第三个参数就是"用户点停止"
    // 那一路的取消信号 —— 不传就等于断言"检索不响应停止"，那不该通过。
    const controller = new AbortController()
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5, signal: controller.signal },
    )
    expect(fetchRagSection).toHaveBeenCalledWith('做个待办应用', 's1', expect.anything())
  })

  it('注入段进了每一轮的 payload，且每轮都在', async () => {
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5 },
    )
    const payloads = streamChat.mock.calls.map((c) => c[0] as Array<{ role: string; content?: string }>)
    expect(payloads.length).toBeGreaterThanOrEqual(2)
    for (const p of payloads) {
      expect(p[0].role).toBe('system')
      expect(p[0].content).toContain('历史参考')
      expect(p[0].content).toContain('佛山天气')
    }
  })

  it('检索返回空串时 system 里不出现历史参考段', async () => {
    fetchRagSection.mockResolvedValue('')
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 2 },
    )
    const first = streamChat.mock.calls[0][0] as Array<{ content?: string }>
    expect(first[0].content).not.toContain('历史参考')
  })
})
