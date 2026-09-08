import { describe, expect, it, vi, afterEach } from 'vitest'
import { truncateMessages, estimateTokens } from '../contextBudget'
import type { Message } from '../../llm/types'

const BIG = 'x'.repeat(3000)

function assistantToolCall(id: string, name: string, args: string): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  }
}

function buildConvo(): Message[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '帮我创建一个应用' },
    assistantToolCall('call_1', 'write_file', JSON.stringify({ path: 'index.html', content: BIG })),
    { role: 'tool', tool_call_id: 'call_1', content: `已写入 index.html (${BIG.length} 字节)` },
    { role: 'assistant', content: '已创建首页' },
    { role: 'user', content: '再加一个关于页' },
    assistantToolCall('call_2', 'read_file', JSON.stringify({ path: 'index.html' })),
    { role: 'tool', tool_call_id: 'call_2', content: BIG },
    { role: 'assistant', content: '已添加关于页' },
    { role: 'user', content: '把标题改一下' },
  ]
}

function toolPairingOK(messages: Message[]): boolean {
  const pending = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant') {
      for (const tc of m.tool_calls ?? []) pending.add(tc.id)
    } else if (m.role === 'tool') {
      if (!pending.has(m.tool_call_id ?? '')) return false
    }
  }
  return true
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('estimateTokens', () => {
  it('按 1 token ≈ 3 字符估算', () => {
    expect(estimateTokens('a'.repeat(90))).toBe(30)
    expect(estimateTokens('ab')).toBe(1)
  })
})

describe('truncateMessages — 未超软限', () => {
  it('原样返回（同一引用）', () => {
    const msgs = buildConvo()
    const out = truncateMessages(msgs, { softLimit: 100000, hardLimit: 200000 })
    expect(out).toBe(msgs)
  })
})

describe('truncateMessages — 阶段一语义压缩', () => {
  it('中间工具轮压为占位符，锚定与最近 2 组保留', () => {
    const msgs = buildConvo()
    // 总量约 (3000*2+其他)/3 ≈ 2200 tokens，软限设 1000 触发阶段一
    const out = truncateMessages(msgs, { softLimit: 1000, hardLimit: 100000 })

    expect(out.some((m) => m.role === 'system' && m.content === 'system prompt')).toBe(true)
    // 锚定首条 user 保留
    expect(out[1]).toMatchObject({ role: 'user', content: '帮我创建一个应用' })
    // 中间不再有 tool_calls / tool 消息
    const middleHasToolTraffic = out.slice(1, -2).some(
      (m) => m.role === 'tool' || m.tool_calls?.length,
    )
    expect(middleHasToolTraffic).toBe(false)
    // 占位符提到工具名
    expect(out.some((m) => m.content.includes('write_file(index.html)'))).toBe(true)
    expect(out.some((m) => m.content.includes('read_file(index.html)'))).toBe(true)
    // 最近 2 组原样保留（最后一条 user + 前面的 assistant 文本）
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: '把标题改一下' })
    expect(out[out.length - 2]).toMatchObject({ role: 'assistant', content: '已添加关于页' })
    // 压缩后确实变小
    const size = (arr: Message[]) => arr.reduce((s, m) => s + m.content.length, 0)
    expect(size(out)).toBeLessThan(size(msgs))
  })

  it('输出始终满足工具配对保护', () => {
    const out = truncateMessages(buildConvo(), { softLimit: 300, hardLimit: 100000 })
    expect(toolPairingOK(out)).toBe(true)
  })
})

describe('truncateMessages — 阶段二硬截断', () => {
  it('倒序贪心保留尾部，丢弃中间整组，顺序保持', () => {
    const msgs = buildConvo()
    // 硬限设很小：system+锚定+最后一组放不下更多
    const out = truncateMessages(msgs, { softLimit: 100, hardLimit: 550 })

    expect(out[0]).toMatchObject({ role: 'system' })
    expect(out[1]).toMatchObject({ role: 'user', content: '帮我创建一个应用' })
    // 最后一组（最后一条 user）必须保留
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: '把标题改一下' })
    // 原消息在输出中保持相对顺序（占位符是新生成的消息，跳过）
    let cursor = 0
    for (const m of out) {
      if (m.content.startsWith('（历史工具调用已压缩')) continue
      const found = msgs.findIndex((o, i) => i >= cursor && o === m)
      expect(found).toBeGreaterThanOrEqual(0)
      cursor = found + 1
    }
    expect(toolPairingOK(out)).toBe(true)
  })

  it('最后一组本身超大时无条件保留（宁可溢出）', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '锚定' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: BIG + BIG + BIG },
    ]
    const out = truncateMessages(msgs, { softLimit: 10, hardLimit: 100 })
    expect(out[out.length - 1].content).toBe(BIG + BIG + BIG)
  })

  it('阶段二不产生悬空 tool 结果（整组丢弃）', () => {
    const out = truncateMessages(buildConvo(), { softLimit: 100, hardLimit: 400 })
    expect(toolPairingOK(out)).toBe(true)
  })
})
