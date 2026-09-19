import { beforeEach, describe, expect, it, vi } from 'vitest'

const CTX = { sessionId: 'session-a' }
const SKILL = 'alibabacloud-oss-sync'

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body }
}

const CATALOG_PAYLOAD = {
  skills: [
    { name: SKILL, displayName: 'OSS 同步', description: '把本地目录同步到 OSS Bucket', source: 'bailian' },
    { name: 'requirement-clarify', displayName: '需求梳理', description: '动手前把一句话需求梳理成结构化需求', source: 'local' },
  ],
  errors: [],
}

/**
 * provider 在模块初始化时就静态注册了 source 与三个工具，所以每份新状态要连着
 * capabilityStore / toolRegistry 一起重新导入 —— 三次 import 落在同一张新模块图上。
 */
async function loadSkills(
  handler: (url: string) => Promise<unknown>,
  seed: Record<string, string> = {},
) {
  vi.resetModules()
  localStorage.clear()
  for (const [k, v] of Object.entries(seed)) localStorage.setItem(k, v)
  const fetchMock = vi.fn(async (input: unknown) => jsonResponse(await handler(String(input))))
  vi.stubGlobal('fetch', fetchMock)
  const skills = await import('../providers/skills')
  const store = await import('../capabilityStore')
  const { registry } = await import('../toolRegistry')
  const { useWorkspaceStore } = await import('../../store/workspaceStore')
  return { skills, store, registry, fetchMock, workspace: useWorkspaceStore }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})

describe('静态注册', () => {
  it('导入即注册三个技能工具与 skills source，不需要先拉目录', async () => {
    const { skills, store, registry } = await loadSkills(() => Promise.reject(new Error('不该发请求')))
    skills.setSkillEnabled(SKILL, true)
    const defs = registry.getDefinitionsFor(store.getEnabledSourceIds()).map((d) => d.name)

    expect(defs).toEqual(expect.arrayContaining(['skill_search', 'skill_load', 'skill_file']))
    expect(skills.SKILL_SOURCE_ID).toBe('skills')
    expect(store.isSourceEnabled('skills')).toBe(true)
  })

  it('一个技能都没开着时这一家算关：三个工具都不发给模型', async () => {
    const { store, registry } = await loadSkills(() => Promise.reject(new Error('不该发请求')))

    expect(store.isSourceEnabled('skills')).toBe(false)
    expect(registry.getDefinitionsFor(store.getEnabledSourceIds()).map((d) => d.name)).not.toContain('skill_load')
    // 内置 fs 工具与 MCP 的筛选互不影响，注册表仍留着技能定义
    expect(registry.getDefinitionsFor(new Set(['skills'])).map((d) => d.name)).toContain('skill_load')
  })

  it('开关从 0 个变成 1 个会让能力快照换引用，definitions 下一轮就带上技能工具', async () => {
    const { skills, store, registry } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    const before = store.getCapabilitySnapshot()

    skills.setSkillEnabled(SKILL, true)

    expect(store.getCapabilitySnapshot()).not.toBe(before)
    expect(registry.getDefinitionsFor(store.getEnabledSourceIds()).map((d) => d.name)).toContain('skill_load')
  })

  it('三个工具的 description 都写了"不执行任何命令"，约束在模型做选择那一刻就到位', async () => {
    const { registry } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    const defs = registry.getDefinitions()
    for (const name of ['skill_search', 'skill_load', 'skill_file']) {
      expect(defs.find((d) => d.name === name)?.description).toContain('本应用不执行任何命令')
    }
  })
})

describe('常驻索引段（K3）', () => {
  it('关掉全部技能时不注入该段', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    expect(skills.buildSkillIndexSection()).toBe('')
  })

  it('开一个技能后按 [来源] name: description 列出，并带上只生成不执行的声明', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)
    skills.setSkillEnabled('requirement-clarify', true)
    await skills.loadSkillCatalog()

    const text = skills.buildSkillIndexSection()
    expect(text).toContain(`- [百炼] ${SKILL}: 把本地目录同步到 OSS Bucket`)
    expect(text).toContain('- [内置] requirement-clarify: 动手前把一句话需求梳理成结构化需求')
    expect(text).toContain('本应用不执行任何命令')
  })

  it('整段永远不超过 9,000 字符，超出的部分留"另有 N 个未列入目录"提示行', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    const many = Array.from({ length: 200 }, (_, i) => ({
      name: `skill-${i}`,
      displayName: `技能 ${i}`,
      description: `说明 ${i}：`.padEnd(200, '字'),
      origin: (i % 2 ? 'bailian' : 'local') as 'bailian' | 'local',
    }))

    const r = skills.renderSkillIndex(many)
    expect(r.text.length).toBeLessThanOrEqual(skills.SKILL_INDEX_BUDGET_CHARS)
    // 只断言"没超"会连"根本没塞满"一起放过，这条才证明闸真的咬住了
    expect(r.text.length).toBeGreaterThan(skills.SKILL_INDEX_BUDGET_CHARS - 200)
    expect(r.omitted).toBeGreaterThan(0)
    expect(r.text).toContain(`另有 ${r.omitted} 个已开技能未列入目录`)
    expect(r.text).toContain('skill_search')
    expect(r.included).toBe(many.length - r.omitted)
  })

  it('预算够时一行提示也不留，全部列进来', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    const r = skills.renderSkillIndex([
      { name: 'a', displayName: 'A', description: '短', origin: 'local' },
      { name: 'b', displayName: 'B', description: '短', origin: 'bailian' },
    ])
    expect(r.omitted).toBe(0)
    expect(r.text).not.toContain('另有')
    expect(r.text).toContain('- [内置] a: 短')
    expect(r.text).toContain('- [百炼] b: 短')
  })

  it('开着但目录里查不到的技能不会静默消失', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled('gone-skill', true)
    // 目录没加载：开关集里有名字却解析不出说明，这句是唯一的可观测痕迹
    expect(skills.buildSkillIndexSection()).toContain('1 个已开技能暂时查不到说明')
  })
})

describe('三个执行器', () => {
  it('skill_load 把"只生成不执行"前言拼在正文头部（随正文一起落库回放）', async () => {
    const body = 'ECS 诊断手册'.repeat(10)
    const { skills, registry } = await loadSkills((url) =>
      Promise.resolve(url.includes('/api/skills/content') ? { text: body, is_error: false } : CATALOG_PAYLOAD)
    )
    skills.setSkillEnabled(SKILL, true)

    const res = await registry.executeDetailed('skill_load', { name: SKILL }, CTX)

    expect(res.isError).toBeFalsy()
    expect(res.text.startsWith(`【技能正文 ${SKILL}】本应用不执行任何命令`)).toBe(true)
    expect(res.text).toContain(body)
  })

  it('skill_load / skill_file / skill_search 全程不读写工作区', async () => {
    const { skills, registry, workspace } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)
    workspace.setState({ filesBySession: { 'session-a': { 'index.html': '<html>' } } })
    const before = workspace.getState().filesBySession

    await registry.executeDetailed('skill_load', { name: SKILL }, CTX)
    await registry.executeDetailed('skill_file', { name: SKILL, path: 'references/ram.md' }, CTX)
    await registry.executeDetailed('skill_search', { keyword: 'OSS' }, CTX)

    expect(workspace.getState().filesBySession).toBe(before)
    expect(workspace.getState().filesFor('session-a')).toEqual({ 'index.html': '<html>' })
    expect(workspace.getState().filesFor('session-b')).toEqual({})
  })

  it('引用文件未找到时回 isError，并明确让模型别编内容', async () => {
    const { skills, registry } = await loadSkills((url) =>
      Promise.resolve(
        url.includes('/api/skills/file')
          ? { text: '引用文件未找到：HTTP 404（references/ghost.md）', is_error: true }
          : CATALOG_PAYLOAD,
      )
    )
    skills.setSkillEnabled(SKILL, true)

    const res = await registry.executeDetailed('skill_file', { name: SKILL, path: 'references/ghost.md' }, CTX)

    expect(res.isError).toBe(true)
    expect(res.text).toContain('该引用文件未找到')
    expect(res.text).toContain('不要凭印象编造')
  })

  it('检索结果带 name 与说明，超长说明就地截断并指向 skill_load', async () => {
    const long = '详细触发词'.repeat(100)
    const { skills, registry } = await loadSkills((url) =>
      Promise.resolve(
        url.includes('/api/skills/search')
          ? { skills: [{ name: 'oss-sync', displayName: 'OSS', description: long, source: 'bailian' }], errors: [] }
          : CATALOG_PAYLOAD,
      )
    )
    skills.setSkillEnabled('oss-sync', true)

    const res = await registry.executeDetailed('skill_search', { keyword: '同步到 OSS' }, CTX)

    expect(res.isError).toBeFalsy()
    expect(res.text).toContain('- oss-sync [百炼]:')
    expect(res.text).toContain('说明已截断')
    expect(res.text.length).toBeLessThan(600)
  })

  it('检索只覆盖开关打开的那些：关着的技能即使目录里有也不回给模型', async () => {
    const { skills, registry } = await loadSkills((url) =>
      Promise.resolve(
        url.includes('/api/skills/search')
          ? {
              skills: [
                { name: SKILL, displayName: 'OSS 同步', description: '开着的那个', source: 'bailian' },
                { name: 'requirement-clarify', displayName: '需求梳理', description: '没开的那个', source: 'local' },
              ],
              errors: [],
            }
          : CATALOG_PAYLOAD,
      )
    )
    skills.setSkillEnabled(SKILL, true)

    const res = await registry.executeDetailed('skill_search', { keyword: '同步' }, CTX)

    expect(res.text).toContain(SKILL)
    expect(res.text).not.toContain('requirement-clarify')
    expect(res.text).not.toContain('没开的那个')
  })

  it('上游说失败（HTTP 仍 200）时透传 isError，界面画成 ✗', async () => {
    const { skills, registry } = await loadSkills(() =>
      Promise.resolve({ text: '技能正文获取失败：HTTP 500', is_error: true })
    )
    skills.setSkillEnabled(SKILL, true)
    const res = await registry.executeDetailed('skill_load', { name: SKILL }, CTX)

    expect(res.isError).toBe(true)
    expect(res.text).toContain('技能正文获取失败')
  })

  it('关掉全部技能时三个工具都不发请求，回一句能让模型改口的 isError', async () => {
    const { skills, registry, fetchMock } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    fetchMock.mockClear()

    for (const [name, args] of [
      ['skill_search', { keyword: 'OSS' }],
      ['skill_load', { name: SKILL }],
      ['skill_file', { name: SKILL, path: 'references/a.md' }],
    ] as const) {
      const res = await registry.executeDetailed(name, args, CTX)
      expect(res.isError).toBe(true)
      expect(res.text).toContain('没有任何打开的技能')
    }
    expect(fetchMock).not.toHaveBeenCalled()
    expect(skills.getEnabledSkillNames()).toEqual([])
  })

  it('只关这一个技能时按名拒绝并指向面板，不会去取它的内容', async () => {
    const { skills, registry, fetchMock } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)
    fetchMock.mockClear()

    const off = await registry.executeDetailed('skill_load', { name: 'requirement-clarify' }, CTX)
    expect(off.isError).toBe(true)
    expect(off.text).toContain('技能 requirement-clarify 的开关没打开')
    expect(off.text).toContain('技能面板')

    expect(
      (await registry.executeDetailed('skill_file', { name: 'requirement-clarify', path: 'references/a.md' }, CTX)).text,
    ).toContain('技能 requirement-clarify 的开关没打开')

    expect(fetchMock).not.toHaveBeenCalled()
    // 同一次调用里开着的那个仍可取
    expect((await registry.executeDetailed('skill_load', { name: SKILL }, CTX)).isError).toBeFalsy()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('缺参数时不发请求，直接回 isError 告诉模型怎么补', async () => {
    const { skills, registry, fetchMock } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)
    fetchMock.mockClear()

    expect((await registry.executeDetailed('skill_load', {}, CTX)).isError).toBe(true)
    expect((await registry.executeDetailed('skill_search', { keyword: '  ' }, CTX)).isError).toBe(true)
    expect((await registry.executeDetailed('skill_file', { name: SKILL }, CTX)).isError).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('开关集是全局偏好', () => {
  it('落在 skills-selected 这一个 key 上，与会话无关', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)

    expect(JSON.parse(localStorage.getItem('skills-selected') ?? '[]')).toEqual([SKILL])
    expect(localStorage.getItem('chat-messages')).toBeNull()
  })

  it('刷新后读回上次开关集', async () => {
    localStorage.setItem('skills-selected', JSON.stringify([SKILL]))
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CATALOG_PAYLOAD)))
    const skills = await import('../providers/skills')

    expect(skills.getEnabledSkillNames()).toEqual([SKILL])
    expect(skills.isSkillEnabled(SKILL)).toBe(true)
  })

  it('坏数据与隐私模式都退回空开关集，不抛出', async () => {
    localStorage.setItem('skills-selected', '{not json')
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(CATALOG_PAYLOAD)))
    const skills = await import('../providers/skills')

    expect(skills.getEnabledSkillNames()).toEqual([])

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    expect(() => skills.setSkillEnabled(SKILL, true)).not.toThrow()
    expect(skills.isSkillEnabled(SKILL)).toBe(true)
  })

  it('目录加载后洗掉已下架的开关项', async () => {
    const { skills } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD), {
      'skills-selected': JSON.stringify([SKILL, 'gone-skill']),
    })
    await skills.loadSkillCatalog()

    expect(skills.getEnabledSkillNames()).toEqual([SKILL])
    expect(JSON.parse(localStorage.getItem('skills-selected') ?? '[]')).toEqual([SKILL])
  })

  it('取消最后一个开关项后长度变化能落盘（幂等：重复开同一项不写）', async () => {
    const { skills, fetchMock } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    skills.setSkillEnabled(SKILL, true)
    fetchMock.mockClear()

    skills.setSkillEnabled(SKILL, true)
    expect(skills.getEnabledSkillNames()).toEqual([SKILL])
    skills.setSkillEnabled(SKILL, false)
    expect(skills.getEnabledSkillNames()).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('目录加载', () => {
  it('App 挂载时的预热只在有开关开着时发请求', async () => {
    const { skills, fetchMock } = await loadSkills(() => Promise.resolve(CATALOG_PAYLOAD))
    fetchMock.mockClear()

    skills.loadSkillCatalogIfEnabled()
    expect(fetchMock).not.toHaveBeenCalled()

    skills.setSkillEnabled(SKILL, true)
    skills.loadSkillCatalogIfEnabled()
    await skills.loadSkillCatalog()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/skills/catalog')
  })

  it('失败后允许重试，不留永久空态', async () => {
    let attempt = 0
    const { skills } = await loadSkills(() => {
      attempt += 1
      return attempt === 1 ? Promise.reject(new Error('boom')) : Promise.resolve(CATALOG_PAYLOAD)
    })
    await skills.loadSkillCatalog()
    expect(skills.getSkillCatalogState().loaded).toBe(false)

    await skills.loadSkillCatalog()
    expect(skills.getSkillCatalogState().skills.map((s) => s.name)).toEqual([SKILL, 'requirement-clarify'])
  })

  it('dev proxy 模式下拿到的是 SPA 外壳（200 但非 JSON）：退化成"目录未加载"而不是空目录', async () => {
    vi.resetModules()
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0')
      },
    })))
    const skills = await import('../providers/skills')

    await expect(skills.loadSkillCatalog()).resolves.toBeUndefined()
    const state = skills.getSkillCatalogState()
    expect(state.loaded).toBe(false)
    expect(state.skills).toEqual([])
    // 关键：错误要能看见，否则面板上的"目录为空"会被误读成上游真没货
    expect(state.errors.length).toBe(1)
  })

  it('后端报的目录异常透出来给面板，不会被当成"目录本来就这么点"', async () => {
    const { skills } = await loadSkills(() =>
      Promise.resolve({
        skills: [
          { name: SKILL, displayName: 'OSS 同步', description: 'd', source: 'bailian' },
          { name: 'x', displayName: 'X', description: 'd', source: 'local' },
        ],
        errors: [{ source: 'bailian', message: 'my-new-skill 状态为 checking，未列入（仅 active 可用）' }],
      })
    )
    await skills.loadSkillCatalog()

    expect(skills.getSkillCatalogState().errors).toEqual(['my-new-skill 状态为 checking，未列入（仅 active 可用）'])
  })
})
