import { describe, it, expect } from 'vitest'
import { streamMock } from '../providers/mock'
import type { Message } from '../types'

describe('mock provider', () => {
  it('yields streaming chunks and ends with done=true', async () => {
    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const chunks: string[] = []
    let sawDone = false

    for await (const chunk of streamMock(messages)) {
      chunks.push(chunk.delta)
      if (chunk.done) sawDone = true
    }

    expect(chunks.length).toBeGreaterThan(0)
    expect(sawDone).toBe(true)
    expect(chunks.join('')).toContain('Mock')
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    const messages: Message[] = [{ role: 'user', content: 'hello' }]
    const chunks: string[] = []

    setTimeout(() => controller.abort(), 100)

    for await (const chunk of streamMock(messages, controller.signal)) {
      chunks.push(chunk.delta)
    }

    expect(chunks.length).toBeLessThan(200)
  })
})
