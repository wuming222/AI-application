import { describe, it, expect } from 'vitest'
import { mergeToolCalls } from '../toolProgress'
import type { AgentToolCallInfo } from '../types'

const row = (over: Partial<AgentToolCallInfo> & { name: string }): AgentToolCallInfo => ({
  callId: over.callId,
  args: {},
  status: 'running',
  ...over,
})

describe('mergeToolCalls', () => {
  it('先内置工具后函数调用时，两个都在（回归：旧实现按名字 find 会丢掉后到的调用）', () => {
    const first = mergeToolCalls(undefined, [{ name: 'web_search', status: 'done' }])
    const merged = mergeToolCalls(first, [{ callId: 'call_1', name: 'write_file' }])

    expect(merged.map((t) => t.name)).toEqual(['web_search', 'write_file'])
    expect(merged[0].status).toBe('done')
    expect(merged[1].status).toBe('running')
  })

  it('同一 callId 的多次快照只有一行', () => {
    const a = mergeToolCalls(undefined, [{ callId: 'call_1', name: 'write_file' }])
    const b = mergeToolCalls(a, [{ callId: 'call_1', name: 'write_file' }])

    expect(b).toHaveLength(1)
  })

  it('已完成的行不会被打回 running', () => {
    const done = [row({ name: 'write_file', callId: 'call_1', status: 'done' })]
    const merged = mergeToolCalls(done, [{ callId: 'call_1', name: 'write_file' }])

    expect(merged[0].status).toBe('done')
  })

  it('外部工具失败：running 能转到 error', () => {
    const running = mergeToolCalls(undefined, [{ callId: 'call_1', name: 'mcp__amap-maps__maps_geo' }])
    const merged = mergeToolCalls(running, [
      { callId: 'call_1', name: 'mcp__amap-maps__maps_geo', status: 'error' },
    ])

    expect(merged[0].status).toBe('error')
  })

  it('error 不会被后到的快照打回 running', () => {
    const failed = [row({ name: 'mcp__amap-maps__maps_geo', callId: 'call_1', status: 'error' })]
    const merged = mergeToolCalls(failed, [{ callId: 'call_1', name: 'mcp__amap-maps__maps_geo' }])

    expect(merged[0].status).toBe('error')
  })

  it('参数后到齐时补上，空参数不覆盖已有值', () => {
    const early = mergeToolCalls(undefined, [{ callId: 'call_1', name: 'write_file' }])
    const withPath = mergeToolCalls(early, [
      { callId: 'call_1', name: 'write_file', args: { path: 'index.html' } },
    ])
    const late = mergeToolCalls(withPath, [{ callId: 'call_1', name: 'write_file', args: {} }])

    expect(early[0].args).toEqual({})
    expect(withPath[0].args).toEqual({ path: 'index.html' })
    expect(late[0].args).toEqual({ path: 'index.html' })
  })

  it('一轮内两个同名工具按 callId 各自独立', () => {
    const merged = mergeToolCalls(undefined, [
      { callId: 'call_a', name: 'write_file' },
      { callId: 'call_b', name: 'write_file' },
    ])
    const afterA = mergeToolCalls(merged, [{ callId: 'call_a', name: 'write_file', status: 'done' }])

    expect(afterA).toHaveLength(2)
    expect(afterA.find((t) => t.callId === 'call_a')?.status).toBe('done')
    expect(afterA.find((t) => t.callId === 'call_b')?.status).toBe('running')
  })

  it('就地更新不影响上一次发出的进度快照', () => {
    const original = mergeToolCalls(undefined, [{ callId: 'call_1', name: 'write_file' }])
    const snapshot = [...original]
    mergeToolCalls(original, [{ callId: 'call_1', name: 'write_file', status: 'done' }])

    expect(snapshot[0].status).toBe('running')
  })
})
