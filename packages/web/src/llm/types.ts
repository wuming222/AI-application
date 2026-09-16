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

// 模型刚开始吐某个函数调用（参数可能还没流完）时的可见状态。
// 与 built_in_tools 分开：那条通道按工具名合并，会让后到的函数调用被挤掉。
export interface FunctionCallStatus {
  callId: string
  name: string
  args?: Record<string, unknown>
}

export interface StreamChunk {
  delta: string
  done: boolean
  tool_calls?: ToolCall[]
  reasoning?: string
  built_in_tools?: BuiltInToolStatus[]
  function_calls?: FunctionCallStatus[]
}
