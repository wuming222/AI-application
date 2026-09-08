import type { Message } from '../llm/types'

export interface TruncateLimits {
  softLimit: number
  hardLimit: number
}

export function resolveLimits(): TruncateLimits {
  const env = import.meta.env as Record<string, string | undefined>
  return {
    softLimit: Number(env.VITE_CONTEXT_SOFT_LIMIT) || 60000,
    hardLimit: Number(env.VITE_CONTEXT_HARD_LIMIT) || 150000,
  }
}

// 设计文档取值：1 token ≈ 3 字符
const CHARS_PER_TOKEN = 3
// 阶段一保留最近 N 组不压缩
const TAIL_GROUPS = 2

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

type Group =
  | { kind: 'system'; msgs: Message[] }
  | { kind: 'anchor'; msgs: Message[] }
  | { kind: 'plain'; msgs: Message[] }
  | { kind: 'toolRound'; msgs: Message[] }

function messageChars(m: Message): number {
  let n = m.content.length
  if (m.tool_calls) n += JSON.stringify(m.tool_calls).length
  return n
}

function groupTokens(g: Group): number {
  const chars = g.msgs.reduce((s, m) => s + messageChars(m), 0)
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function totalTokens(groups: Group[]): number {
  return groups.reduce((s, g) => s + groupTokens(g), 0)
}

function toGroups(messages: Message[]): Group[] {
  const groups: Group[] = []
  let anchorAssigned = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'system') {
      groups.push({ kind: 'system', msgs: [m] })
      continue
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      const msgs: Message[] = [m]
      while (i + 1 < messages.length && messages[i + 1].role === 'tool') {
        msgs.push(messages[++i])
      }
      groups.push({ kind: 'toolRound', msgs })
      continue
    }
    if (m.role === 'user' && !anchorAssigned) {
      groups.push({ kind: 'anchor', msgs: [m] })
      anchorAssigned = true
      continue
    }
    groups.push({ kind: 'plain', msgs: [m] })
  }
  return groups
}

function safeParse(argsStr: string): Record<string, unknown> {
  try {
    return JSON.parse(argsStr)
  } catch {
    return {}
  }
}

function summarizeToolRound(g: Group): Message {
  const names: string[] = []
  for (const m of g.msgs) {
    for (const tc of m.tool_calls ?? []) {
      let detail = tc.function.name
      const args = safeParse(tc.function.arguments)
      if (typeof args.path === 'string') detail += `(${args.path})`
      names.push(detail)
    }
  }
  return {
    role: 'assistant',
    content: `（历史工具调用已压缩：${names.join('、') || '无'}。文件内容已存于工作区，需要时用 read_file 获取。）`,
  }
}

function isCompressible(g: Group): boolean {
  if (g.kind === 'toolRound') return true
  return g.kind === 'plain' && g.msgs[0]?.role === 'tool'
}

function hardTruncate(groups: Group[], hardLimit: number): Group[] {
  const anchorIdx = groups.findIndex((g) => g.kind === 'anchor')
  const head = anchorIdx >= 0 ? groups.slice(0, anchorIdx + 1) : []
  const rest = anchorIdx >= 0 ? groups.slice(anchorIdx + 1) : groups.slice()

  let budget = hardLimit - totalTokens(head)
  const tail: Group[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const g = rest[i]
    const t = groupTokens(g)
    if (i === rest.length - 1) {
      // 最后一组无条件保留：宁可溢出也不丢当前对话
      budget -= t
      tail.unshift(g)
      continue
    }
    if (budget - t < 0) break
    budget -= t
    tail.unshift(g)
  }
  return [...head, ...tail]
}

export function truncateMessages(messages: Message[], limits: TruncateLimits): Message[] {
  if (messages.length === 0) return messages

  const groups = toGroups(messages)
  const before = totalTokens(groups)
  if (before <= limits.softLimit) return messages

  // 阶段一：语义压缩——保留 system、锚定首条 user、最近 N 组；中间工具流量压为占位符。
  // 占位符比原组还大时保留原组，避免"压缩"反而增大上下文
  const tailStart = Math.max(groups.length - TAIL_GROUPS, 0)
  let compressed = false
  const stage1 = groups.map((g, i) => {
    if (i < tailStart && isCompressible(g)) {
      const placeholder = summarizeToolRound(g)
      if (estimateTokens(placeholder.content) < groupTokens(g)) {
        compressed = true
        return { kind: 'plain', msgs: [placeholder] } as Group
      }
    }
    return g
  })

  if (compressed) {
    console.info(`[context] 阶段一压缩: ${before} → ${totalTokens(stage1)} tokens`)
  }

  const afterStage1 = totalTokens(stage1)
  if (afterStage1 <= limits.hardLimit) {
    return stage1.flatMap((g) => g.msgs)
  }

  // 阶段二：硬截断——倒序贪心，整组丢弃
  const stage2 = hardTruncate(stage1, limits.hardLimit)
  console.info(`[context] 阶段二硬截断: ${afterStage1} → ${totalTokens(stage2)} tokens`)
  return stage2.flatMap((g) => g.msgs)
}
