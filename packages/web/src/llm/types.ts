export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  images?: string[]
  tool_calls?: ToolCall[]
  tool_call_id?: string
  reasoning?: string
}

export interface BuiltInToolStatus {
  name: string
  status: 'in_progress' | 'searching' | 'completed'
}

export interface StreamChunk {
  delta: string
  done: boolean
  tool_calls?: ToolCall[]
  reasoning?: string
  built_in_tools?: BuiltInToolStatus[]
}
