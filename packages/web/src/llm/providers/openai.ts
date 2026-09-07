import type { Message, StreamChunk, ToolCall } from '../types'
import type { StreamChatOptions } from '../router'

export async function* streamOpenAI(
  messages: Message[],
  signal?: AbortSignal,
  options?: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  const model = import.meta.env.VITE_LLM_MODEL || 'deepseek-chat'

  const body: Record<string, unknown> = { model, messages, stream: true }
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  const base = import.meta.env.VITE_API_BASE_URL || ''
  const res = await fetch(`${base}/api/llm/chat/completions`, {
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
  const pendingToolCalls = new Map<number, ToolCall>()

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
      const dataLine = frame
        .split('\n')
        .find((l) => l.startsWith('data: '))
      if (!dataLine) continue

      const payload = dataLine.slice(6).trim()
      if (payload === '[DONE]') {
        const toolCalls = Array.from(pendingToolCalls.values())
        yield { delta: '', done: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }
        return
      }

      try {
        const json = JSON.parse(payload)
        const choice = json.choices?.[0]
        if (!choice) continue

        const delta = choice.delta?.content || ''
        const finished = choice.finish_reason != null

        // Handle streaming tool_calls
        const tcDelta = choice.delta?.tool_calls
        if (tcDelta && Array.isArray(tcDelta)) {
          for (const tc of tcDelta) {
            const idx = tc.index ?? 0
            if (!pendingToolCalls.has(idx)) {
              pendingToolCalls.set(idx, {
                id: tc.id || `call_${idx}`,
                type: 'function',
                function: { name: '', arguments: '' },
              })
            }
            const existing = pendingToolCalls.get(idx)!
            if (tc.id) existing.id = tc.id
            if (tc.function?.name) existing.function.name += tc.function.name
            if (tc.function?.arguments) existing.function.arguments += tc.function.arguments
          }
        }

        if (delta) yield { delta, done: false }
        if (finished) {
          const toolCalls = Array.from(pendingToolCalls.values())
          yield { delta: '', done: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }
          return
        }
      } catch {
        console.warn('SSE frame parse failed:', payload)
      }
    }
  }

  const toolCalls = Array.from(pendingToolCalls.values())
  yield { delta: '', done: true, tool_calls: toolCalls.length > 0 ? toolCalls : undefined }
}
