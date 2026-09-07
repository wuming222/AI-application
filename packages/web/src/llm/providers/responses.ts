import type { Message, StreamChunk, ToolCall } from '../types'
import type { StreamChatOptions } from '../router'

export async function* streamResponses(
  messages: Message[],
  signal?: AbortSignal,
  options?: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  const model = import.meta.env.VITE_LLM_MODEL || 'qwen3.7-flash'

  const tools: Record<string, unknown>[] = [{ type: 'web_search' }]
  if (options?.tools) {
    for (const t of options.tools) {
      tools.push({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })
    }
  }

  const body = {
    model,
    input: messages,
    stream: true,
    tools,
  }

  const base = import.meta.env.VITE_API_BASE_URL || ''
  const res = await fetch(`${base}/api/llm/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(`LLM request failed: ${res.status} ${res.statusText}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pendingFunctionCalls = new Map<string, ToolCall>()

  while (true) {
    if (signal?.aborted) {
      reader.cancel()
      return
    }

    const { value, done } = await reader.read()
    if (done) break

    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() || ''

    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
      if (!dataLine) continue

      const payload = dataLine.slice(5).trim()
      if (!payload || payload === '[DONE]') continue

      try {
        const event = JSON.parse(payload)

        if ((event.type === 'response.output_text.delta' || event.type === 'response.reasoning_text.delta') && event.delta) {
          yield { delta: event.delta, done: false }
        }

        if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
          const itemId = event.item.id || `call_${pendingFunctionCalls.size}`
          pendingFunctionCalls.set(itemId, {
            id: itemId,
            type: 'function',
            function: {
              name: event.item.name || '',
              arguments: event.item.arguments || '',
            },
          })
        }

        if (event.type === 'response.function_call_arguments.delta') {
          const itemId = event.item_id || event.item?.id
          if (itemId && pendingFunctionCalls.has(itemId)) {
            const tc = pendingFunctionCalls.get(itemId)!
            tc.function.arguments += event.delta || ''
          }
        }

        if (event.type === 'response.completed') {
          const toolCalls = Array.from(pendingFunctionCalls.values())
          yield { delta: '', done: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }
          return
        }
      } catch {
        console.warn('Responses SSE parse failed:', payload)
      }
    }
  }

  const toolCalls = Array.from(pendingFunctionCalls.values())
  yield { delta: '', done: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }
}
