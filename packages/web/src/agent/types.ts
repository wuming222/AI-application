export interface AgentLoopOptions {
  maxRounds?: number
  onProgress?: (progress: AgentProgress) => void
  signal?: AbortSignal
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
