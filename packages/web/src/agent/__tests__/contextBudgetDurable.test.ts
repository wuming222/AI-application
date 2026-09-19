import { describe, expect, it } from 'vitest'
import type { Message } from '../../llm/types'
import { truncateMessages, estimateTokens, isDurableToolName } from '../contextBudget'

const BIG = 'x'.repeat(3000)
const BODY = 'S'.repeat(3000)

function assistantToolCall(id: string, name: string, args: unknown): Message {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  }
}

function skillRound(id: string, name: string): Message[] {
  return [
    assistantToolCall(id, 'skill_load', { name }),
    { role: 'tool', tool_call_id: id, content: `【技能正文 ${name}】${BODY}` },
  ]
}

function fileRound(id: string, path: string): Message[] {
  return [
    assistantToolCall(id, 'write_file', { path, content: BIG }),
    { role: 'tool', tool_call_id: id, content: `已写入 ${path}` },
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

/** 三份正文 + 一长段普通工具流量，总量远超 softLimit */
function buildSkillConvo(): Message[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'user', content: '帮我把本地文件同步到 OSS' },
    ...skillRound('c1', 'oss-sync'),
    ...skillRound('c2', 'ecs-diagnose'),
    ...skillRound('c3', 'rds-backup'),
    ...fileRound('c4', 'index.html'),
    { role: 'assistant', content: '已给出方案' },
    { role: 'user', content: '再讲讲权限怎么配' },
  ]
}

const countBodies = (arr: Message[]) => arr.filter((m) => m.content.includes(BODY)).length

describe('isDurableToolName', () => {
  it('只有 skill_load 是 durable，检索与引用文件不是', () => {
    expect(isDurableToolName('skill_load')).toBe(true)
    expect(isDurableToolName('skill_search')).toBe(false)
    expect(isDurableToolName('skill_file')).toBe(false)
    expect(isDurableToolName('write_file')).toBe(false)
  })
})

describe('durable 豁免额度', () => {
  it('连续 load 三个技能时，最早的正文降级为专用占位行，最近两个原样保留', () => {
    const out = truncateMessages(buildSkillConvo(), { softLimit: 1000, hardLimit: 100000 })

    // K5：最坏 3 份正文就吃掉 softLimit 的 95%，所以额度只有 2
    expect(countBodies(out)).toBe(2)
    expect(out.some((m) => m.content.includes(BODY) && m.content.includes('rds-backup'))).toBe(true)
    expect(out.some((m) => m.content.includes(BODY) && m.content.includes('ecs-diagnose'))).toBe(true)

    const placeholder = out.find((m) => m.content.includes('该技能正文已移出上下文'))
    expect(placeholder?.content).toContain('skill_load(oss-sync)')
    // 不能复用文件工具那句：技能正文既不在工作区，也 read_file 不回来
    expect(placeholder?.content).not.toContain('文件内容已存于工作区')
    expect(toolPairingOK(out)).toBe(true)
  })

  it('额度内的正文不会被压掉，也不会冒出专用占位行', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '锚定' },
      ...skillRound('c1', 'tiny'),
      ...fileRound('c2', 'index.html'),
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ]
    const out = truncateMessages(msgs, { softLimit: 10, hardLimit: 100000 })
    // 短正文不会被压掉，也不该冒出占位行
    expect(out.some((m) => m.content.includes('该技能正文已移出上下文'))).toBe(false)
    expect(toolPairingOK(out)).toBe(true)
  })

  it('durable 豁免 + 长历史时，阶段二丢的是整组对话而不是被豁免的正文，配对不破', () => {
    const msgs = buildSkillConvo()
    // hardLimit 卡在"两份豁免正文 + 锚定 + 尾部"放不下的大小
    const total = estimateTokens(
      msgs.map((m) => m.content).join(''),
    )
    const out = truncateMessages(msgs, { softLimit: 1000, hardLimit: Math.round(total * 0.5) })

    expect(out[0]).toMatchObject({ role: 'system' })
    expect(out[1]).toMatchObject({ role: 'user', content: '帮我把本地文件同步到 OSS' })
    expect(out[out.length - 1]).toMatchObject({ role: 'user', content: '再讲讲权限怎么配' })
    expect(toolPairingOK(out)).toBe(true)
    // 保留下来的正文一定是最近那两份，不是被截断留到前面的旧正文
    expect(out.some((m) => m.content.includes('oss-sync') && m.content.includes(BODY))).toBe(false)
    // 整组丢弃：任何一条 tool 消息都不会脱离它的 assistant 单独留下
    for (const m of out.filter((x) => x.role === 'tool')) {
      expect(out.some((x) => x.tool_calls?.some((tc) => tc.id === m.tool_call_id))).toBe(true)
    }
  })

  it('普通工具轮仍走原占位文案，不受 durable 逻辑影响', () => {
    const msgs: Message[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: '锚定' },
      ...fileRound('c1', 'index.html'),
      ...fileRound('c2', 'about.html'),
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' },
    ]
    const out = truncateMessages(msgs, { softLimit: 1000, hardLimit: 100000 })
    const placeholder = out.find((m) => m.content.includes('历史工具调用已压缩'))
    expect(placeholder?.content).toContain('文件内容已存于工作区')
    expect(placeholder?.content).toContain('write_file(index.html)')
    expect(out.some((m) => m.content.includes('该技能正文已移出上下文'))).toBe(false)
  })
})
