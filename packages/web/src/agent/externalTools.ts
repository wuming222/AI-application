import type { McpServerInfo, ExternalToolsSnapshot } from './types'
import { registry } from './toolRegistry'
import type { ToolResult } from './toolRegistry'

/**
 * 外部工具（MCP）在前端的加载、注册与逐 server 开关。
 *
 * 连接由服务端持有（见 packages/server/app/mcp/），这里只负责：
 * 1. 拉工具清单并一次性注册进进程级 registry；
 * 2. 持有"哪个 server 开着"这个**全局偏好**（localStorage），并把它筛到发给模型的副本上。
 *
 * 开关不是会话状态：它不进 chatStore.bySession、不落库。因此生成中途翻开关不影响在飞的那一轮
 * （definitions 在每次 runAgentLoop 开始处只读一次），下一轮才生效。
 */

const ENABLEMENT_KEY = 'mcp-servers-enabled'
const BASE = import.meta.env.VITE_API_BASE_URL || ''

// 服务端的三条上界：call_tool 30s、每个 server 的清单 20s（两个 server 并发，所以清单总和也是
// 20s 而不是 40s，见 routes/mcp.py）。这里统一宽一档，让服务端那句更可读的超时文案先回来。
const REQUEST_TIMEOUT_MS = 35_000

let servers: McpServerInfo[] = []
let readyPromise: Promise<void> | null = null
let snapshot: ExternalToolsSnapshot = { servers, enabled: {} }

const listeners = new Set<() => void>()

function readOverrides(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(ENABLEMENT_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const out: Record<string, boolean> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'boolean') out[k] = v
    }
    return out
  } catch {
    // 隐私模式 / 配额满：退回服务端默认值，开关失效但不能挡住生成
    return {}
  }
}

function writeOverrides(overrides: Record<string, boolean>): void {
  try {
    localStorage.setItem(ENABLEMENT_KEY, JSON.stringify(overrides))
  } catch {
    // 存不下就只活在这一页
  }
}

function recompute(): void {
  const overrides = readOverrides()
  const enabled: Record<string, boolean> = {}
  for (const s of servers) enabled[s.id] = overrides[s.id] ?? s.defaultEnabled
  snapshot = { servers: [...servers], enabled }
}

function notify(): void {
  for (const fn of listeners) fn()
}

export function subscribeExternalTools(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** useSyncExternalStore 的快照：引用只在 load / 翻开关时换，避免每次读都触发重渲染。 */
export function getExternalToolsSnapshot(): ExternalToolsSnapshot {
  return snapshot
}

export function isServerEnabled(id: string): boolean {
  return snapshot.enabled[id] === true
}

export function getEnabledServiceIds(): Set<string> {
  return new Set(Object.keys(snapshot.enabled).filter((id) => snapshot.enabled[id]))
}

export function setServerEnabled(id: string, on: boolean): void {
  writeOverrides({ ...readOverrides(), [id]: on })
  recompute()
  notify()
}

function makeExecutor(service: string, tool: string) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    // 挡的是模型凭上一轮上下文幻觉调用：定义没发给它，但它可能还记得
    if (!isServerEnabled(service)) {
      return { text: '外部工具未启用：该 MCP 服务当前在输入框的外部工具开关里是关闭状态。', isError: true }
    }
    try {
      const res = await fetch(`${BASE}/api/mcp/call`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ service, tool, arguments: args }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        return { text: `外部工具调用失败：HTTP ${res.status}`, isError: true }
      }
      const data = (await res.json()) as { text?: unknown; is_error?: unknown }
      return {
        text: typeof data.text === 'string' ? data.text : '(空结果)',
        isError: data.is_error === true,
      }
    } catch (err) {
      return { text: `外部工具调用失败：${(err as Error).message}`, isError: true }
    }
  }
}

/** 幂等：同一时刻只发一次清单请求；失败后允许下一轮重试。 */
export function loadExternalTools(): Promise<void> {
  if (!readyPromise) readyPromise = doLoad()
  return readyPromise
}

export function externalToolsReady(): Promise<void> {
  return loadExternalTools()
}

async function doLoad(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/api/mcp/tools`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      servers?: { id?: unknown; label?: unknown; defaultEnabled?: unknown }[]
      tools?: { name?: unknown; service?: unknown; tool?: unknown; description?: unknown; parameters?: unknown }[]
      errors?: { service?: string; message?: string }[]
    }
    for (const e of data.errors ?? []) {
      console.warn(`[mcp] ${e.service} 工具清单拉取失败: ${e.message}`)
    }
    servers = (data.servers ?? [])
      .filter((s) => typeof s.id === 'string')
      .map((s) => ({
        id: String(s.id),
        label: typeof s.label === 'string' ? s.label : String(s.id),
        defaultEnabled: s.defaultEnabled !== false,
      }))
    // 名字已带 mcp__<service>__ 前缀（见 routes/mcp.py），不会与内置 fs 工具撞名
    for (const t of data.tools ?? []) {
      if (typeof t.name !== 'string' || typeof t.service !== 'string' || typeof t.tool !== 'string') continue
      registry.register(
        {
          name: t.name,
          description: typeof t.description === 'string' ? t.description : '',
          parameters:
            t.parameters && typeof t.parameters === 'object'
              ? (t.parameters as Record<string, unknown>)
              : { type: 'object', properties: {} },
        },
        { execute: makeExecutor(t.service, t.tool) },
        { mcpService: t.service },
      )
    }
  } catch (err) {
    // 后端不可用 / 没配 VITE_API_BASE_URL：一个外部工具也不注册，行为退回没有 MCP 的 app
    console.warn('[mcp] 外部工具清单加载失败:', (err as Error).message)
    servers = []
    readyPromise = null
  }
  recompute()
  notify()
}
