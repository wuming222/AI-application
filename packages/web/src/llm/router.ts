import type { Message, StreamChunk, ToolDefinition } from './types'
import { streamMock } from './providers/mock'
import { streamResponses } from './providers/responses'

type Provider = 'mock' | 'responses'

function getProvider(): Provider {
  return (import.meta.env.VITE_LLM_PROVIDER as Provider) || 'responses'
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
  const stream = provider === 'mock' ? streamMock : streamResponses

  yield* stream(messages, signal, options)
}
