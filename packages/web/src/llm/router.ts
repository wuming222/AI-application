import type { Message, StreamChunk, ToolDefinition } from './types'
import { streamMock } from './providers/mock'
import { streamOpenAI } from './providers/openai'

type Provider = 'mock' | 'openai'

function getProvider(): Provider {
  return (import.meta.env.VITE_LLM_PROVIDER as Provider) || 'mock'
}

export interface StreamChatOptions {
  tools?: ToolDefinition[]
}

export async function* streamChat(
  messages: Message[],
  signal?: AbortSignal,
  options?: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  if (signal?.aborted) return

  const provider = getProvider()
  const stream = provider === 'openai' ? streamOpenAI : streamMock

  yield* stream(messages, signal, options)
}
