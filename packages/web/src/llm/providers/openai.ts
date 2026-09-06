import type { Message, StreamChunk } from '../types'

export async function* streamOpenAI(
  messages: Message[],
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const model = import.meta.env.VITE_LLM_MODEL || 'deepseek-chat'

  const base = import.meta.env.VITE_API_BASE_URL || ''
  const res = await fetch(`${base}/api/llm/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })

  if (!res.ok || !res.body) {
    throw new Error(`LLM request failed: ${res.status} ${res.statusText}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

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
        yield { delta: '', done: true }
        return
      }

      try {
        const json = JSON.parse(payload)
        const choice = json.choices?.[0]
        if (!choice) continue

        const delta = choice.delta?.content || ''
        const finished = choice.finish_reason != null

        if (delta) yield { delta, done: false }
        if (finished) {
          yield { delta: '', done: true }
          return
        }
      } catch {
        console.warn('SSE frame parse failed:', payload)
      }
    }
  }

  yield { delta: '', done: true }
}
