import { describe, it, expect } from 'vitest'

function parseSSEFrames(raw: string): Array<{ delta: string; done: boolean }> {
  const results: Array<{ delta: string; done: boolean }> = []
  const frames = raw.split('\n\n')

  for (const frame of frames) {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!dataLine) continue

    const payload = dataLine.slice(6).trim()
    if (payload === '[DONE]') {
      results.push({ delta: '', done: true })
      continue
    }

    try {
      const json = JSON.parse(payload)
      const choice = json.choices?.[0]
      if (!choice) continue

      const delta = choice.delta?.content || ''
      const finished = choice.finish_reason != null

      if (delta) results.push({ delta, done: false })
      if (finished) results.push({ delta: '', done: true })
    } catch {
      // skip malformed frames
    }
  }

  return results
}

describe('SSE frame parsing', () => {
  it('parses text deltas correctly', () => {
    const raw = `data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\ndata: [DONE]`
    const results = parseSSEFrames(raw)

    expect(results).toEqual([
      { delta: 'Hello', done: false },
      { delta: ' world', done: false },
      { delta: '', done: true },
    ])
  })

  it('handles finish_reason stop', () => {
    const raw = `data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`
    const results = parseSSEFrames(raw)

    expect(results).toEqual([
      { delta: 'ok', done: false },
      { delta: '', done: true },
    ])
  })

  it('skips malformed JSON frames', () => {
    const raw = `data: {"choices":[{"delta":{"content":"good"}}]}\n\ndata: {broken json}\n\ndata: {"choices":[{"delta":{"content":"still good"}}]}`
    const results = parseSSEFrames(raw)

    expect(results).toHaveLength(2)
    expect(results[0].delta).toBe('good')
    expect(results[1].delta).toBe('still good')
  })
})
