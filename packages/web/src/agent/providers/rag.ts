import type { CapabilitySourceInfo } from '../types'
import { applyProviderSources, isSourceEnabled } from '../capabilityStore'
import { authFetch } from '../../api/auth'

/**
 * 历史参考（RAG）provider。与 MCP / 技能两家的根本差别：**它不注册任何工具**。
 * 检索由每轮生成无条件发起，模型没有"要不要查"的决定权 —— 按论文定义这不是 Self-RAG，
 * 是 fixed top-k 前置召回。所以这里只有两件事：提供一个全局开关，和把检索结果拼成文本。
 *
 * 面板那一行是白送的：CapabilityPanel 按 `kind !== 'skill'` 过滤渲染，一个没有工具定义的
 * source 照样拿到一个 Switch。代价是 `registry.getDefinitionsFor()` 筛不到任何东西 ——
 * 这个开关的唯一作用点就是本文件 `fetchRagSection` 开头那一句判断。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''
export const RAG_SOURCE_ID = 'rag'
const SOURCE: CapabilitySourceInfo = {
  id: RAG_SOURCE_ID,
  label: '历史参考',
  kind: 'rag',
  // 默认关：开关一开就无条件给每个人的第一轮加一次外部调用，与 AntV 那条同口径。
  defaultEnabled: false,
}
const REQUEST_TIMEOUT_MS = 2000 // 与 MCP 握手同档：等不到就当本轮没有，见 runAgentLoop 的 MCP_HANDSHAKE_WAIT_MS
const MAX_CARDS = 5

applyProviderSources('rag', [SOURCE]) // 模块 import 期注册，与 providers/skills.ts 同形态

export interface RagCard {
  sessionId: string
  title: string
  requirement: string
  paths: string[]
}

/** 拼成 system prompt 的一段。空数组返回空串 —— 绝不写"没有找到历史参考"，
 * 那句话会被模型读成用户在抱怨它没记性。 */
export function buildRagSection(cards: RagCard[]): string {
  if (cards.length === 0) return ''
  const lines = cards.map((c) => {
    const text = c.requirement || c.title
    const files = c.paths.length > 0 ? `  ·  文件: ${c.paths.join(', ')}` : ''
    return `- 「${text}」${files}`
  })
  return (
    '\n\n## 历史参考（该账号过往会话，仅作偏好线索，不是本次需求的一部分）\n' +
    lines.join('\n')
  )
}

type LooseMessage = { role: string; content?: unknown }

/** 检索词只取用户原话，不取 assistant 的复述 —— 后者会把模型自己的措辞喂回去当历史。 */
export function lastUserQuery(messages: LooseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function normalizeCards(raw: unknown): RagCard[] {
  if (!Array.isArray(raw)) return []
  const out: RagCard[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.sessionId !== 'string' || typeof o.title !== 'string') continue
    out.push({
      sessionId: o.sessionId,
      title: o.title,
      requirement: typeof o.requirement === 'string' ? o.requirement : '',
      paths: Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : [],
    })
    if (out.length >= MAX_CARDS) break
  }
  return out
}

/** 全仓唯一一次读 `rag` 开关：关着就返回空串且不发请求。 */
export async function fetchRagSection(
  query: string,
  excludeSessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isSourceEnabled(RAG_SOURCE_ID)) return ''
  if (!query.trim()) return ''
  try {
    const url =
      `${BASE}/api/rag/search?q=${encodeURIComponent(query)}` +
      `&exclude=${encodeURIComponent(excludeSessionId)}&limit=${MAX_CARDS}`
    const res = await authFetch(url, { signal: mergeSignal(signal) })
    if (!res.ok) return ''
    const data = (await res.json()) as { results?: unknown }
    return buildRagSection(normalizeCards(data.results))
  } catch {
    // 后端挂了 / 没配 VITE_API_BASE_URL / vite 把 /api 回成 SPA 外壳：本轮没有历史参考而已
    return ''
  }
}

function mergeSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  if (!caller) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  // AbortSignal.any 还不是所有环境都有；缺了就只受 2s 上限约束（调用方 abort 由
  // runAgentLoop 在 round 顶部 break 兜住，不会白跑一轮生成）
  return anyFn ? anyFn([caller, timeout]) : timeout
}
