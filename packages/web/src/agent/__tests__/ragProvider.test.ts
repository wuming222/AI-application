import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRagSection, fetchRagSection, lastUserQuery, RAG_SOURCE_ID } from '../providers/rag'
import { setSourceEnabled } from '../capabilityStore'
import type { RagCard } from '../providers/rag'

const card = (over: Partial<RagCard> = {}): RagCard => ({
  sessionId: 's1', title: '天气A', requirement: '看一下佛山的天气', paths: ['index.html'], ...over,
})

describe('buildRagSection', () => {
  it('空结果就是空串，不写"没有找到历史参考"', () => {
    expect(buildRagSection([])).toBe('')
  })

  it('卡片带原话与文件名，并带那句划界文案', () => {
    const s = buildRagSection([card()])
    expect(s).toContain('不是本次需求的一部分')
    expect(s).toContain('看一下佛山的天气')
    expect(s).toContain('文件: index.html')
    expect((s.match(/不是本次需求的一部分/g) ?? []).length).toBe(1)
  })

  it('无需求原话时退回会话标题', () => {
    const s = buildRagSection([card({ requirement: '', title: '天气落地页' })])
    expect(s).toContain('天气落地页')
  })

  it('以 \n\n 起头，拼在 system 正文后面不会黏成一坨', () => {
    expect(buildRagSection([card()]).startsWith('\n\n')).toBe(true)
  })
})

describe('lastUserQuery', () => {
  it('取最后一条有文字的 user 消息', () => {
    expect(lastUserQuery([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二条' },
    ])).toBe('第二条')
  })

  it('跳过空白与多模态（content 不是字符串）的那条，继续往前找', () => {
    expect(lastUserQuery([
      { role: 'user', content: '可用的文字' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '   ' },
      { role: 'user', content: [{ type: 'text', text: '不是字符串形状' }] },
    ])).toBe('可用的文字')
  })

  it('一条都没有时返回空串', () => {
    expect(lastUserQuery([{ role: 'assistant', content: '好' }])).toBe('')
  })
})

describe('fetchRagSection 的开关与降级', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
  })

  it('开关关着时一个请求也不发（判据处只有这一处读 store）', async () => {
    setSourceEnabled(RAG_SOURCE_ID, false)
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('查询为空时不发请求', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    await expect(fetchRagSection('   ', 's1')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('5xx 静默降级为空串，不抛', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
  })

  it('坏 JSON 静默降级', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response('<html>SPA 外壳</html>', { status: 200 }))
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
  })

  it('畸形条目被逐条丢掉而不是整体崩', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [card(), { sessionId: 1 }, null, { sessionId: 's2', title: 'x' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const s = await fetchRagSection('佛山天气', 's1')
    expect(s).toContain('看一下佛山的天气')
    // 四条里只有两条形状合法（第二条 sessionId 不是字符串、第三条是 null）。
    // 不收窄条数的话，normalizeCards 完全不滤形也会被画成 - 「undefined」 而这条照过。
    expect((s.match(/^- /gm) ?? []).length).toBe(2)
    expect(s).not.toContain('undefined')
  })

  it('出厂默认就是关的（谁都没翻过开关）', async () => {
    // 上面那条"开关关着"是先 setSourceEnabled(false) 显式写的，所以它守不住默认值：
    // 谁把 defaultEnabled 改成 true，其余用例全绿，而线上变成无条件给每人第一轮加一次外部调用。
    //
    // 必须 resetModules：capabilityStore 的 enabled 快照是模块级内存态，在 import 时算一次。
    // beforeEach 里的 localStorage.clear() 只清存值、不清快照 —— 上一条用例 setSourceEnabled(true)
    // 的效果还在，直接断默认值会假红（踩过）。forgetSourceOverride 也不 recompute，它只是存值原语。
    localStorage.clear()
    vi.resetModules()
    const fresh = await import('../providers/rag')
    await expect(fresh.fetchRagSection('佛山天气', 's1')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('capabilities-enabled')).toBeNull()
  })

  it('用户在检索期间点停止 → 请求真的被中止，且不抛', async () => {
    // SDD 降级格第二条。它此前一条证据都没有：Task 6 把整个 rag 模块 mock 掉了，
    // 而这里的用例又从不传第三个参数，mergeSignal 那一路只靠代码审查撑着。
    setSourceEnabled(RAG_SOURCE_ID, true)
    const controller = new AbortController()
    let captured: AbortSignal | undefined
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          captured = init.signal ?? undefined
          const onAbort = () => reject(new DOMException('aborted', 'AbortError'))
          if (captured?.aborted) onAbort()
          else captured?.addEventListener('abort', onAbort)
        }),
    )

    const pending = fetchRagSection('佛山天气', 's1', controller.signal)
    expect(captured, 'fetch 没拿到任何 signal —— 取消信号根本没接进去').toBeTruthy()
    controller.abort()
    // 必须在 await 之前同步断言。放到 await 之后就废了：mergeSignal 里那个 2s timeout
    // 自己也会 abort，于是"用户点了停止"与"超时到了"给出同样的读数（实测这条曾因此空过）。
    expect(captured?.aborted, '调用方的 abort 没传到 fetch 的 signal 上').toBe(true)
    await expect(pending).resolves.toBe('')
  })

  it('超过 5 条只留 5 张卡，划界文案仍只出现一次', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    const many = Array.from({ length: 7 }, (_, i) => card({ requirement: `第${i}句原话` }))
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ results: many }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const s = await fetchRagSection('佛山天气', 's1')
    expect((s.match(/^- /gm) ?? []).length).toBe(5)
    expect((s.match(/不是本次需求的一部分/g) ?? []).length).toBe(1)
    expect(s).not.toContain('第6句原话')
  })

  it('上游一直不回话时，2s 计时器把请求切掉并降级成空串', async () => {
    // 验收里"5xx / 超时 → 生成照常跑"的超时那一半：只断言过 5xx 与坏 JSON 的话，
    // "请求挂住、整轮生成跟着挂住"这种坏法是测不出来的。
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const t0 = Date.now()
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
    const spent = Date.now() - t0
    expect(spent).toBeGreaterThanOrEqual(1500) // 真是被计时器切掉的，不是提前返回
    expect(spent).toBeLessThan(6000)
  }, 20000)
})
