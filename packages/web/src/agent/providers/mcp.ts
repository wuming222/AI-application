import type { CapabilitySourceInfo } from '../types'
import { registry } from '../toolRegistry'
import type { ToolResult } from '../toolRegistry'
import { applyProviderSources, isSourceEnabled } from '../capabilityStore'
import { authFetch } from '../../api/auth'

/**
 * MCP provider：把服务端的工具清单（见 packages/server/app/mcp/）注册进进程级 registry，
 * 并把逐 server 的开关状态挂到 capabilityStore 的 'mcp' 那一组上。
 *
 * 连接由服务端持有，这里只做两件事：拉清单 + 执行时转发一次 HTTP。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''

// 服务端的三条上界：call_tool 30s、每个 server 的清单 20s（两个 server 并发，所以清单总和也是
// 20s 而不是 40s，见 routes/mcp.py）。这里统一宽一档，让服务端那句更可读的超时文案先回来。
const REQUEST_TIMEOUT_MS = 35_000

let readyPromise: Promise<void> | null = null

function makeExecutor(service: string, tool: string) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    // 挡的是模型凭上一轮上下文幻觉调用：定义没发给它，但它可能还记得
    if (!isSourceEnabled(service)) {
      return { text: '外部工具未启用：该 MCP 服务当前在输入框的外部工具开关里是关闭状态。', isError: true }
    }
    try {
      const res = await authFetch(`${BASE}/api/mcp/call`, {
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
export function loadMcpCapabilities(): Promise<void> {
  if (!readyPromise) readyPromise = doLoad()
  return readyPromise
}

/** 只有 MCP 需要等这一步（握手是异步的）；skill 侧的定义是静态注册的，不参与这场 race。 */
export function mcpCapabilitiesReady(): Promise<void> {
  return loadMcpCapabilities()
}

async function doLoad(): Promise<void> {
  let listed: CapabilitySourceInfo[] = []
  try {
    const res = await authFetch(`${BASE}/api/mcp/tools`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = (await res.json()) as {
      servers?: { id?: unknown; label?: unknown; defaultEnabled?: unknown }[]
      tools?: { name?: unknown; service?: unknown; tool?: unknown; description?: unknown; parameters?: unknown }[]
      errors?: { service?: string; message?: string }[]
    }
    for (const e of data.errors ?? []) {
      console.warn(`[mcp] ${e.service} 工具清单拉取失败: ${e.message}`)
    }
    listed = (data.servers ?? [])
      .filter((s) => typeof s.id === 'string')
      .map((s) => ({
        id: String(s.id),
        label: typeof s.label === 'string' ? String(s.label) : String(s.id),
        kind: 'mcp' as const,
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
        { provider: 'mcp', sourceId: t.service, durability: 'transient', effect: 'data' },
      )
    }
  } catch (err) {
    // 后端不可用 / 没配 VITE_API_BASE_URL：一个外部工具也不注册，行为退回没有 MCP 的 app
    console.warn('[mcp] 外部工具清单加载失败:', (err as Error).message)
    listed = []
    readyPromise = null
  }
  applyProviderSources('mcp', listed)
}
