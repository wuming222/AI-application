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

export interface McpServerInfo {
  id: string
  label: string
  defaultEnabled: boolean
}

/** 外部工具的整体可读状态（全局偏好，不分会话）。引用稳定，供 useSyncExternalStore 用。 */
export interface ExternalToolsSnapshot {
  servers: McpServerInfo[]
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
