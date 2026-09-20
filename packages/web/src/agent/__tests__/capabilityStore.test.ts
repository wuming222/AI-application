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

/**
 * 每个用例都要重新拿一份干净的模块状态（registry 与 capabilityStore 都是模块级的）。
 *
 * store 与 mcp provider 拆成两个模块后必须一起导入：resetModules 之后这两次 import 落在同一张新图上，
 * 所以 provider 写的就是测试读的。分开拿会读到两份互不相干的 store，表现是"翻了开关快照没变"。
 */
async function loadWith(handler: (url: string) => Promise<unknown>) {
  vi.resetModules()
  localStorage.clear()
  const fetchMock = vi.fn(async (input: unknown, _init?: { body?: string }) => {
    const url = String(input)
    return jsonResponse(await handler(url))
  })
  vi.stubGlobal('fetch', fetchMock)
  const mcp = await import('../providers/mcp')
  const store = await import('../capabilityStore')
  const { registry } = await import('../toolRegistry')
  return { mcp, store, registry, fetchMock }
}

async function loadTools(payload: unknown = TOOLS_PAYLOAD) {
  const loaded = await loadWith((url) =>
    Promise.resolve(url.endsWith('/api/mcp/tools') ? payload : { text: '', is_error: false })
  )
  await loaded.mcp.loadMcpCapabilities()
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
    await loaded.mcp.loadMcpCapabilities()

    expect(loaded.store.getEnabledSourceIds().size).toBe(0)
    expect(loaded.registry.getDefinitionsFor(new Set([AMAP])).map((d) => d.name)).not.toContain(
      `mcp__${AMAP}__maps_geo`
    )
  })

  it('默认开关下发给模型的清单里没有任何 AntV 工具，amap 的在', async () => {
    const { store, registry } = await loadTools()
    const sent = registry.getDefinitionsFor(store.getEnabledSourceIds()).map((d) => d.name)

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
    const mcp = await import('../providers/mcp')
    const { registry } = await import('../toolRegistry')

    await expect(mcp.loadMcpCapabilities()).resolves.toBeUndefined()
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
    await expect(loaded.mcp.loadMcpCapabilities()).resolves.toBeUndefined()
    await loaded.mcp.loadMcpCapabilities()

    expect(loaded.store.isSourceEnabled(AMAP)).toBe(true)
  })

  it('快照引用只在数据变化时更换，满足 useSyncExternalStore', async () => {
    const { store } = await loadTools()
    const first = store.getCapabilitySnapshot()

    expect(store.getCapabilitySnapshot()).toBe(first)
    store.setSourceEnabled(AMAP, false)
    expect(store.getCapabilitySnapshot()).not.toBe(first)
  })
})

describe('技能没有总闸：派生 enabled 与旧值迁移', () => {
  /** 技能一家的开关在 `skills-selected`，`capabilities-enabled` 里那一格已经没人读了。 */
  async function loadSkillsProvider(seed: Record<string, string>) {
    vi.resetModules()
    localStorage.clear()
    for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TOOLS_PAYLOAD)))
    const skills = await import('../providers/skills')
    const store = await import('../capabilityStore')
    return { skills, store }
  }

  it('有一个技能开着这一家才算开，全关即整家关（不看存值）', async () => {
    const { skills, store } = await loadSkillsProvider({})
    expect(store.isSourceEnabled('skills')).toBe(false)

    skills.setSkillEnabled('requirement-clarify', true)
    expect(store.isSourceEnabled('skills')).toBe(true)

    skills.setSkillEnabled('requirement-clarify', false)
    expect(store.isSourceEnabled('skills')).toBe(false)
  })

  it('派生值盖过存值：那一格被写成 false 也不影响"开了技能就是开"', async () => {
    const { skills, store } = await loadSkillsProvider({})
    // 死值清一次就够，之后谁再写这格（旧代码路径、手改 localStorage）都不该有读者
    store.setSourceEnabled('skills', false)
    skills.setSkillEnabled('requirement-clarify', true)

    expect(JSON.parse(localStorage.getItem('capabilities-enabled') ?? '{}').skills).toBe(false)
    expect(store.isSourceEnabled('skills')).toBe(true)
  })

  it('旧的"总闸关"搬成"逐技能全关"，并把那一格从存储里清掉', async () => {
    const { skills, store } = await loadSkillsProvider({
      'capabilities-enabled': JSON.stringify({ 'agent-skills': false, [AMAP]: false }),
      'skills-selected': JSON.stringify(['requirement-clarify']),
    })

    expect(skills.getEnabledSkillNames()).toEqual([])
    expect(store.isSourceEnabled('skills')).toBe(false)
    const saved = JSON.parse(localStorage.getItem('capabilities-enabled') ?? '{}') as Record<string, boolean>
    expect(saved['agent-skills']).toBeUndefined()
    expect(saved['skills']).toBeUndefined()
    // 同一次写入不能把别家的设置顺手弄丢
    expect(saved[AMAP]).toBe(false)
  })

  it('旧总闸是开的（或从没碰过）时不清空逐技能开关集', async () => {
    const on = await loadSkillsProvider({
      'capabilities-enabled': JSON.stringify({ 'agent-skills': true }),
      'skills-selected': JSON.stringify(['requirement-clarify']),
    })
    expect(on.skills.getEnabledSkillNames()).toEqual(['requirement-clarify'])
    expect(on.store.isSourceEnabled('skills')).toBe(true)

    const untouched = await loadSkillsProvider({ 'skills-selected': JSON.stringify(['a', 'b']) })
    expect(untouched.skills.getEnabledSkillNames()).toEqual(['a', 'b'])
  })
})

describe('逐 source 开关', () => {
  it('defaultEnabled 决定初值，AntV 默认关', async () => {
    const { store } = await loadTools()
    const enabled = store.getEnabledSourceIds()

    expect(enabled.has(AMAP)).toBe(true)
    expect(enabled.has(ANTV)).toBe(false)
  })

  it('翻开关写 localStorage 并通知订阅者', async () => {
    const { store } = await loadTools()
    const seen = vi.fn()
    store.subscribeCapabilities(seen)

    store.setSourceEnabled(ANTV, true)

    expect(store.isSourceEnabled(ANTV)).toBe(true)
    expect(seen).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('capabilities-enabled') ?? '{}')).toEqual({ [ANTV]: true })
  })

  it('开关是全局偏好：翻完之后再取一份仍然是同一个值，与会话无关', async () => {
    const { store } = await loadTools()

    store.setSourceEnabled(AMAP, false)

    expect(store.isSourceEnabled(AMAP)).toBe(false)
    expect(JSON.parse(localStorage.getItem('capabilities-enabled') ?? '{}')).toEqual({ [AMAP]: false })
  })

  it('刷新后读回上次偏好', async () => {
    localStorage.setItem('capabilities-enabled', JSON.stringify({ [AMAP]: false, [ANTV]: true }))
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TOOLS_PAYLOAD)))
    const mcp = await import('../providers/mcp')
    const store = await import('../capabilityStore')
    await mcp.loadMcpCapabilities()

    expect(store.getEnabledSourceIds()).toEqual(new Set([ANTV]))
  })

  it('旧 key mcp-servers-enabled 的值迁到 capabilities-enabled，旧 key 删掉', async () => {
    localStorage.setItem('mcp-servers-enabled', JSON.stringify({ [AMAP]: false, [ANTV]: true }))
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TOOLS_PAYLOAD)))
    const mcp = await import('../providers/mcp')
    const store = await import('../capabilityStore')
    await mcp.loadMcpCapabilities()

    expect(store.getEnabledSourceIds()).toEqual(new Set([ANTV]))
    expect(localStorage.getItem('mcp-servers-enabled')).toBeNull()
    expect(JSON.parse(localStorage.getItem('capabilities-enabled') ?? '{}')).toEqual({
      [AMAP]: false,
      [ANTV]: true,
    })
  })

  it('两个 key 都在时新 key 赢，迁移不把较新的偏好覆盖回去', async () => {
    localStorage.setItem('mcp-servers-enabled', JSON.stringify({ [AMAP]: false }))
    localStorage.setItem('capabilities-enabled', JSON.stringify({ [AMAP]: true }))
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(TOOLS_PAYLOAD)))
    const mcp = await import('../providers/mcp')
    const store = await import('../capabilityStore')
    await mcp.loadMcpCapabilities()

    expect(store.isSourceEnabled(AMAP)).toBe(true)
  })

  it('localStorage 抛异常时退回服务端默认值，不中断生成', async () => {
    const { store } = await loadTools()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })

    expect(() => store.setSourceEnabled(AMAP, false)).not.toThrow()
    expect(store.isSourceEnabled(AMAP)).toBe(true)
    expect(store.isSourceEnabled(ANTV)).toBe(false)
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
    const { store, registry, fetchMock } = await loadTools()
    store.setSourceEnabled(AMAP, false)

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
