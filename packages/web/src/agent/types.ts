export interface AgentLoopOptions {
  maxRounds?: number
  onProgress?: (progress: AgentProgress) => void
  signal?: AbortSignal
  // 这一路生成归属哪条会话；工具读写与工作区落库都按它定向，不用"当前打开的会话"
  sessionId: string
}

export interface ToolContext {
  sessionId: string
}

/** 能力的提供方。管道（发现→注册→开关→面板→进度→错误）两边共用，语义差异见 durability / effect。 */
export type CapabilityKind = 'mcp' | 'skill'
/** transient = 压掉无妨（这一次的事实）；durable = 之后每一轮都要遵守（如 skill 正文）。 */
export type ToolDurability = 'transient' | 'durable'
/** data = 只回答数据；instructions = 返回值会改写模型后续行为。 */
export type ToolEffect = 'data' | 'instructions'

export interface CapabilitySourceInfo {
  id: string
  label: string
  kind: CapabilityKind
  defaultEnabled: boolean
}

/** 能力（MCP + skill）的整体可读状态（全局偏好，不分会话）。引用稳定，供 useSyncExternalStore 用。 */
export interface CapabilitySnapshot {
  sources: CapabilitySourceInfo[]
  enabled: Record<string, boolean>
}

export interface AgentProgress {
  steps: AgentProgressStep[]
  finished: boolean
  startAt: number
}

export interface AgentToolCallInfo {
  // 对齐键：同名工具在一轮里被调用两次时，只有 callId 能分清是哪一行
  callId?: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
}

export interface AgentProgressStep {
  round: number
  reasoningText?: string
  status: 'thinking' | 'tool-call' | 'done'
  toolCalls?: AgentToolCallInfo[]
}
