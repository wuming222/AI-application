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

export interface AgentProgressStep {
  round: number
  thinkingText: string
  status: 'thinking' | 'done'
}
