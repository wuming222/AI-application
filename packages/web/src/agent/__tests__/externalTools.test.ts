import { beforeEach, describe, expect, it, vi } from 'vitest'

const AMAP = 'amap-maps'
const ANTV = 'antv-visualization-chart'
const ctx = { sessionId: 'session-a' }

const TOOLS_PAYLOAD = {
  servers: [
    { id: AMAP, label: '高德地图', defaultEnabled: true },
    { id: ANTV, label: 'AntV 图表', defaultEnabled: false },
  ],
  tools: [
    {
      name: `mcp__${AMAP}__maps_geo`,
      service: AMAP,
      tool: 'maps_geo',
      description: '地址转坐标',
      parameters: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
    },
    {
      name: `mcp__${ANTV}__generate`,
      service: ANTV,
      tool: 'generate',
      description: '生成图表',
      parameters: { type: 'object', properties: {} },
    },
  ],
  errors: [],
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

/** 每个用例都要重新拿一份干净的模块状态（registry / snapshot 是模块级的）。 */
async function loadWith(handler: (url: string) => Promise<unknown>) {
  vi.resetModules()
  localStorage.clear()
  const fetchMock = vi.fn(async (input: unknown, _init?: { body?: string }) => {
    const url = String(input)
    return jsonResponse(await handler(url))
  })
  vi.stubGlobal('fetch', fetchMock)
  const mod = await import('../externalTools')
  const { registry } = await import('../toolRegistry')
  return { mod, registry, fetchMock }
}

async function loadTools(payload: unknown = TOOLS_PAYLOAD) {
  const loaded = await loadWith((url) =>
    Promise.resolve(url.endsWith('/api/mcp/tools') ? payload : { text: '', is_error: false })
  )
  await loaded.mod.loadExternalTools()
  loaded.fetchMock.mockClear()
  return loaded
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('清单加载与注册', () => {
  it('外部工具带着 mcp__<service>__ 前缀进注册表，schema 原样透传', async () => {
    const { registry } = await loadTools()
    const defs = registry.getDefinitionsFor(new Set([AMAP, ANTV]))
    const geo = defs.find((d) => d.name === `mcp__${AMAP}__maps_geo`)

    expect(geo?.description).toBe('地址转坐标')
    expect(geo?.parameters).toEqual({
      type: 'object',
      properties: { address: { type: 'string' } },
      required: ['address'],
    })
  })

  it('内置 fs 工具与外部工具共存，筛掉外部也还在', async () => {
    const { registry } = await loadTools()

    expect(registry.getDefinitionsFor(new Set()).map((d) => d.name)).toContain('write_file')
  })

  it('清单接口挂掉时一个外部工具也不注册，行为退回无 MCP', async () => {
    const loaded = await loadWith(() => Promise.reject(new Error('Failed to fetch')))
    await loaded.mod.loadExternalTools()
    const { registry } = loaded

    expect(loaded.mod.getEnabledServiceIds().size).toBe(0)
    expect(registry.getDefinitionsFor(new Set([AMAP])).map((d) => d.name)).not.toContain(
      `mcp__${AMAP}__maps_geo`
    )
  })

  it('默认开关下发给模型的清单里没有任何 AntV 工具，amap 的在', async () => {
    const { mod, registry } = await loadTools()
    const sent = registry.getDefinitionsFor(mod.getEnabledServiceIds()).map((d) => d.name)

    expect(sent.filter((n) => n.startsWith(`mcp__${ANTV}__`))).toEqual([])
    expect(sent).toContain(`mcp__${AMAP}__maps_geo`)
  })

  it('dev proxy 模式下拿到的是 SPA 外壳（200 text/html），退化成没有外部工具而不是报错', async () => {
    vi.resetModules()
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    })))
    const mod = await import('../externalTools')
    const { registry } = await import('../toolRegistry')

    await expect(mod.loadExternalTools()).resolves.toBeUndefined()
    expect(registry.getDefinitionsFor(new Set([AMAP])).map((d) => d.name)).not.toContain(
      `mcp__${AMAP}__maps_geo`
    )
  })

  it('清单失败后下一轮允许重试，失败不留永久空态', async () => {
    let attempt = 0
    const loaded = await loadWith(() => {
      attempt += 1
      return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(TOOLS_PAYLOAD)
    })
    await expect(loaded.mod.loadExternalTools()).resolves.toBeUndefined()
    await loaded.mod.loadExternalTools()

    expect(loaded.mod.isServerEnabled(AMAP)).toBe(true)
  })

  it('快照引用只在数据变化时更换，满足 useSyncExternalStore', async () => {
    const { mod } = await loadTools()
    const first = mod.getExternalToolsSnapshot()

    expect(mod.getExternalToolsSnapshot()).toBe(first)
    mod.setServerEnabled(AMAP, false)
    expect(mod.getExternalToolsSnapshot()).not.toBe(first)
  })
})

describe('逐 server 开关', () => {
  it('defaultEnabled 决定初值，AntV 默认关', async () => {
    const { mod } = await loadTools()
    const enabled = mod.getEnabledServiceIds()

    expect(enabled.has(AMAP)).toBe(true)
    expect(enabled.has(ANTV)).toBe(false)
  })

  it('翻开关写 localStorage 并通知订阅者', async () => {
    const { mod } = await loadTools()
    const seen = vi.fn()
    mod.subscribeExternalTools(seen)

    mod.setServerEnabled(ANTV, true)

    expect(mod.isServerEnabled(ANTV)).toBe(true)
    expect(seen).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('mcp-servers-enabled') ?? '{}')).toEqual({ [ANTV]: true })
  })

  it('开关是全局偏好：翻完之后再取一份仍然是同一个值，与会话无关', async () => {
    const { mod } = await loadTools()

    mod.setServerEnabled(AMAP, false)

    expect(mod.isServerEnabled(AMAP)).toBe(false)
    expect(JSON.parse(localStorage.getItem('mcp-servers-enabled') ?? '{}')).toEqual({ [AMAP]: false })
  })

  it('刷新后读回上次偏好', async () => {
    localStorage.setItem('mcp-servers-enabled', JSON.stringify({ [AMAP]: false, [ANTV]: true }))
    vi.resetModules()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(TOOLS_PAYLOAD))
    )
    const mod = await import('../externalTools')
    await mod.loadExternalTools()

    expect(mod.getEnabledServiceIds()).toEqual(new Set([ANTV]))
  })

  it('localStorage 抛异常时退回服务端默认值，不中断生成', async () => {
    const { mod } = await loadTools()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => mod.setServerEnabled(AMAP, false)).not.toThrow()
    expect(mod.isServerEnabled(AMAP)).toBe(true)
    expect(mod.isServerEnabled(ANTV)).toBe(false)
  })
})

describe('执行器', () => {
  it('启用中才打 /api/mcp/call，参数与 service/tool 一一对应', async () => {
    const { registry, fetchMock } = await loadTools()
    fetchMock.mockImplementation(async () => jsonResponse({ text: '{"location":"120,30"}', is_error: false }))

    const res = await registry.executeDetailed(`mcp__${AMAP}__maps_geo`, { address: '西湖' }, ctx)

    expect(res.isError).toBeFalsy()
    expect(res.text).toContain('120,30')
    const [call] = fetchMock.mock.calls
    expect(String(call[0])).toMatch(/\/api\/mcp\/call$/)
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      service: AMAP,
      tool: 'maps_geo',
      arguments: { address: '西湖' },
    })
  })

  it('服务被关掉时不调网络，回一句能让模型改口的 isError', async () => {
    const { mod, registry, fetchMock } = await loadTools()
    mod.setServerEnabled(AMAP, false)

    const res = await registry.executeDetailed(`mcp__${AMAP}__maps_geo`, { address: '西湖' }, ctx)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(res.isError).toBe(true)
    expect(res.text).toContain('外部工具未启用')
  })

  it('上游说失败（HTTP 仍 200）时透传 isError，界面画成 ✗', async () => {
    const { registry, fetchMock } = await loadTools()
    fetchMock.mockImplementation(async () =>
      jsonResponse({ text: 'API 调用失败：USER_DAILY_QUERY_OVER_LIMIT', is_error: true })
    )

    const res = await registry.executeDetailed(`mcp__${AMAP}__maps_geo`, { address: '西湖' }, ctx)

    expect(res.isError).toBe(true)
    expect(res.text).toContain('USER_DAILY_QUERY_OVER_LIMIT')
  })

  it('网络异常与非 200 都转成 isError 而不是抛出', async () => {
    const { registry, fetchMock } = await loadTools()
    fetchMock.mockImplementation(async () => {
      throw new Error('Network request failed')
    })
    const down = await registry.executeDetailed(`mcp__${AMAP}__maps_geo`, {}, ctx)

    fetchMock.mockImplementation(async () => jsonResponse({}, false, 502))
    const badGateway = await registry.executeDetailed(`mcp__${AMAP}__maps_geo`, {}, ctx)

    expect(down.isError).toBe(true)
    expect(badGateway.text).toContain('HTTP 502')
  })
})
