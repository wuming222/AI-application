import { describe, expect, it } from 'vitest'
import { registry } from '../toolRegistry'
import type { ToolDefinition } from '../../llm/types'

const ctx = { sessionId: 'session-a' }

function def(name: string): ToolDefinition {
  return { name, description: '', parameters: { type: 'object', properties: {} } }
}

describe('getDefinitionsFor', () => {
  it('内置 fs 工具不受外部开关影响，空集合也照样发出去', () => {
    const names = registry.getDefinitionsFor(new Set()).map((d) => d.name)

    expect(names).toContain('write_file')
    expect(names).toContain('read_file')
    expect(names).toContain('edit_file')
  })

  it('只发启用中的外部 server 的定义', () => {
    registry.register(def('mcp__amap-maps__maps_geo'), { execute: () => 'geo' }, { mcpService: 'amap-maps' })
    registry.register(def('mcp__antv__generate'), { execute: () => 'chart' }, { mcpService: 'antv' })

    const onAmap = registry.getDefinitionsFor(new Set(['amap-maps'])).map((d) => d.name)
    expect(onAmap).toContain('mcp__amap-maps__maps_geo')
    expect(onAmap).not.toContain('mcp__antv__generate')

    const none = registry.getDefinitionsFor(new Set()).map((d) => d.name)
    expect(none).not.toContain('mcp__amap-maps__maps_geo')
  })

  it('筛选只作用于发出去的副本，注册表本身不被 unregister', () => {
    registry.register(def('mcp__keep__tool'), { execute: () => 'kept' }, { mcpService: 'keep' })

    registry.getDefinitionsFor(new Set())

    expect(registry.has('mcp__keep__tool')).toBe(true)
  })

  it('另一路生成筛掉的服务，不影响本路仍然能执行已注册的执行器', () => {
    registry.register(def('mcp__shared__tool'), { execute: () => 'ran' }, { mcpService: 'shared' })

    registry.getDefinitionsFor(new Set())

    expect(registry.getDefinitionsFor(new Set(['shared'])).map((d) => d.name)).toContain('mcp__shared__tool')
  })
})

describe('executeDetailed', () => {
  it('字符串返回值补成 ToolResult 且不算失败', async () => {
    registry.register(def('fs-like'), { execute: () => 'plain text' })

    await expect(registry.executeDetailed('fs-like', {}, ctx)).resolves.toEqual({ text: 'plain text' })
  })

  it('执行器抛异常转成 isError 而不是把主循环打断', async () => {
    registry.register(def('boom'), {
      execute: () => {
        throw new Error('写入失败')
      },
    })

    const res = await registry.executeDetailed('boom', {}, ctx)

    expect(res.isError).toBe(true)
    expect(res.text).toContain('写入失败')
  })

  it('未知工具（模型幻觉出的名字）回 isError', async () => {
    const res = await registry.executeDetailed('mcp__ghost__nope', {}, ctx)

    expect(res.isError).toBe(true)
    expect(res.text).toContain('未知工具')
  })

  it('execute 仍返回纯文本，兼容既有调用点', async () => {
    registry.register(def('mcp__x__y'), { execute: () => ({ text: '外部结果', isError: true }) })

    await expect(registry.execute('mcp__x__y', {}, ctx)).resolves.toBe('外部结果')
  })
})
