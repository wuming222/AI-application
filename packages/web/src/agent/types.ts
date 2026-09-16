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

export interface AgentProgress {
  steps: AgentProgressStep[]
  finished: boolean
  startAt: number
}

export interface AgentToolCallInfo {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  result?: string
}

export interface AgentProgressStep {
  round: number
  thinkingText: string
  reasoningText?: string
  status: 'thinking' | 'tool-call' | 'done'
  toolCalls?: AgentToolCallInfo[]
}
