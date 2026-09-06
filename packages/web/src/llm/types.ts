export interface Message {
  role: 'user' | 'assistant'
  content: string
}

export interface StreamChunk {
  delta: string
  done: boolean
}
