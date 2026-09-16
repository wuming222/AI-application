import { describe, it, expect, afterEach, vi } from 'vitest'
import { streamResponses } from '../providers/responses'
import type { Message, StreamChunk } from '../types'

const messages: Message[] = [{ role: 'user', content: '做个小应用' }]

function sseResponse(events: unknown[]) {
  const encoder = new TextEncoder()
  const frames = events.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
  let cursor = 0
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          cursor < frames.length
            ? { value: frames[cursor++], done: false }
            : { value: undefined, done: true },
        cancel: () => {},
      }),
    },
  }
}

async function collect(events: unknown[]): Promise<StreamChunk[]> {
  vi.stubGlobal('fetch', async () => sseResponse(events))
  const out: StreamChunk[] = []
  for await (const chunk of streamResponses(messages)) out.push(chunk)
  return out
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('responses — 函数调用的进度事件', () => {
  it('function_call 一出现就 yield 工具状态，不必等整条流结束', async () => {
    const chunks = await collect([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'call_1', name: 'write_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"path":"' },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: 'index.html"}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const progress = chunks.filter((c) => c.function_calls)
    expect(progress).toHaveLength(1)
    expect(progress[0].function_calls).toEqual([{ callId: 'call_1', name: 'write_file' }])
  })

  it('参数流完时快照里没有半截 args，收尾仍给出完整 tool_calls', async () => {
    const chunks = await collect([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'call_1', name: 'write_file', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'call_1', delta: '{"path":"index.html"}' },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(chunks.find((c) => c.function_calls)?.function_calls?.[0].args).toBeUndefined()
    const last = chunks[chunks.length - 1]
    expect(last.done).toBe(true)
    expect(last.tool_calls?.[0].function.arguments).toBe('{"path":"index.html"}')
  })

  it('上游在 added 事件里就给全参数时，快照直接带上 args（UI 能立刻显示文件名）', async () => {
    const chunks = await collect([
      {
        type: 'response.output_item.added',
        item: {
          type: 'function_call',
          id: 'call_1',
          name: 'write_file',
          arguments: '{"path":"index.html"}',
        },
      },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    expect(chunks.find((c) => c.function_calls)?.function_calls?.[0].args).toEqual({
      path: 'index.html',
    })
  })

  it('多个函数调用累积成全量快照，后一个不会顶掉前一个', async () => {
    const chunks = await collect([
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'call_a', name: 'write_file', arguments: '' } },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'call_b', name: 'edit_file', arguments: '' } },
      { type: 'response.completed', response: { status: 'completed' } },
    ])

    const snapshots = chunks.filter((c) => c.function_calls)
    expect(snapshots.map((c) => c.function_calls?.map((f) => f.callId))).toEqual([
      ['call_a'],
      ['call_a', 'call_b'],
    ])
  })
})
