import type { CapabilitySourceInfo } from '../types'
import { registry } from '../toolRegistry'
import type { ToolResult } from '../toolRegistry'
import { applyProviderSources, forgetSourceOverride, isSourceEnabled, peekSourceOverride } from '../capabilityStore'

/**
 * skill provider：把技能（内置 + 百炼）接成一个能力来源，与 MCP 并列。
 *
 * 与 `providers/mcp.ts` 共用同一条管道（清单 → 注册 → 开关 → 面板 → 错误契约），
 * 差在两个语义上，这两处**不统一**是本特性的立论所在：
 * - MCP 工具返回的是**这一次的事实**（data / transient），压掉无所谓；
 * - `skill_load` 返回的是**之后每一轮都要遵守的操作手册**（instructions / durable），
 *   被上下文预算阶段一压掉就等于技能白接了 —— 所以它有 `contextBudget` 里的豁免额度。
 *
 * 三个工具的定义是**静态注册**的（模块导入即完成，不发请求），所以它们不占 K9 那场
 * 2s race：只有 MCP 的清单要等服务端逐 server 握手。
 *
 * 与 MCP 第三处不统一：**技能没有总闸**。开关是逐技能的（存在 `skills-selected` 里，选=开），
 * 这一家整体"开不开"由它派生（有一个开着才算开），所以 `capabilities-enabled` 里不再存技能那一格。
 * 代价是"关掉所有技能"与"从没开过"在存储上同形 —— 这也正是它该有的样子。
 *
 * 首版接的是阿里云那条匿名的 agentexplorer 目录（source id 当时叫 `agent-skills`），
 * 09-19 换成百炼的技能接口并撤掉旧通道；旧总闸值的一次性迁移就在这个模块下面（`legacyMaster`）。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''

/** 后端 read 超时是 30s（app/skills/sources.py），这里必须严格大于它，否则先到的是 fetch 的 AbortError。 */
const REQUEST_TIMEOUT_MS = 35_000

export const SKILL_SOURCE_ID = 'skills'
export const SKILL_SOURCE_LABEL = '技能'

/** 常驻索引整段的上界（K3：6,000 真 token @1.5 字符/token = softLimit 60,000 的 10%）。 */
export const SKILL_INDEX_BUDGET_CHARS = 9_000

/** 技能来源：内置 = 随仓库分发的本地技能包，bailian = 用户自己传到百炼技能库的包。 */
export type SkillOrigin = 'local' | 'bailian'

/** 索引行、检索结果与面板三处共用同一套标签，写不一致就没法对照着核。 */
export const SKILL_ORIGIN_TAGS: Record<SkillOrigin, string> = {
  local: '内置',
  bailian: '百炼',
}

/**
 * 逐技能开关集：**全局偏好**（与 MCP 的开关同理，它不属于任何一条会话），在里面 = 开着。
 * 存储 key 仍叫 `skills-selected`：装的还是同一份名字列表，换 key 只会多一次没人受益的迁移。
 * 但"这一轮注入了哪些正文"是会话状态 —— 正文作为 role:'tool' 消息落库。
 */
const ENABLED_KEY = 'skills-selected'

/** 面板、工具 description、正文前言三处共用的承诺，措辞保持一致才好核对。 */
export const GENERATE_ONLY_NOTICE =
  '本应用不执行任何命令：技能只提供规范与经验，据此产出交付物（代码、配置、Terraform、供用户自行执行的命令清单及其前置条件），不得声称已执行。'

export interface SkillSummary {
  name: string
  displayName: string
  description: string
  /** 来源标签用；服务端缺这个字段时按百炼算（现在只有它一家远端来源）。 */
  origin: SkillOrigin
}

const SOURCE: CapabilitySourceInfo = {
  id: SKILL_SOURCE_ID,
  label: SKILL_SOURCE_LABEL,
  kind: 'skill',
  // 这一家没有存值开关：开不开 = 有没有任何一个技能开着。defaultEnabled 在这里不参与判定，
  // 填 false 只是免得有人看见 true 以为"技能默认全开"
  defaultEnabled: false,
  resolveEnabled: () => enabledNames.length > 0,
}

let catalogSkills: SkillSummary[] = []
let catalogErrors: string[] = []
let catalogLoaded = false
let catalogPromise: Promise<void> | null = null

/**
 * 一次性迁移：旧的"总闸关"要翻译成"每个技能都关"。
 *
 * 不翻的话，先前关着技能通道、同时留着几个名字的用户，会在这次升级后发现那几个名字自己亮了 ——
 * 把他明确关过的东西重新打开，比丢一份名单严重。
 */
const legacyMaster = peekSourceOverride(SKILL_SOURCE_ID) ?? peekSourceOverride('agent-skills')
forgetSourceOverride(SKILL_SOURCE_ID)
forgetSourceOverride('agent-skills')

let enabledNames: string[] = legacyMaster === false ? [] : readEnabledNames()
if (legacyMaster === false) writeEnabledNames([])
const storeListeners = new Set<() => void>()

function readEnabledNames(): string[] {
  try {
    const raw = localStorage.getItem(ENABLED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((v): v is string => typeof v === 'string')))
  } catch {
    // 隐私模式 / 配额满 / 坏数据：当作什么都没开过，不值得为此中断生成
    return []
  }
}

function writeEnabledNames(names: string[]): void {
  try {
    localStorage.setItem(ENABLED_KEY, JSON.stringify(names))
  } catch {
    // 存不下就只活在这一页
  }
}

function notifyStore(): void {
  // 开关集一变，"这一家开不开"的派生值就要重算：能力快照与面板、runAgentLoop 读的是同一份
  applyProviderSources('skill', [SOURCE])
  for (const fn of storeListeners) fn()
}

/** 面板订阅这一个就够：开关集与目录状态的变化都走它。 */
export function subscribeSkillsStore(fn: () => void): () => void {
  storeListeners.add(fn)
  return () => storeListeners.delete(fn)
}

export function getEnabledSkillNames(): string[] {
  return enabledNames
}

export function isSkillEnabled(name: string): boolean {
  return enabledNames.includes(name)
}

export function setSkillEnabled(name: string, on: boolean): void {
  const next = on
    ? Array.from(new Set([...enabledNames, name]))
    : enabledNames.filter((n) => n !== name)
  if (next.length === enabledNames.length) return
  enabledNames = next
  writeEnabledNames(next)
  notifyStore()
}

async function getJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, { signal: signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

function toSummaries(payload: unknown): { skills: SkillSummary[]; errors: string[] } {
  const data = payload as { skills?: unknown; errors?: unknown }
  const skills = Array.isArray(data?.skills)
    ? data.skills
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .filter((r) => typeof r.name === 'string')
        .map((r) => ({
          name: String(r.name),
          displayName: typeof r.displayName === 'string' ? r.displayName : String(r.name),
          description: typeof r.description === 'string' ? r.description : '',
          origin: r.source === 'local' ? ('local' as const) : ('bailian' as const),
        }))
    : []
  const errors = Array.isArray(data?.errors)
    ? data.errors
        .filter((e): e is { message?: unknown } => !!e && typeof e === 'object')
        .map((e) => String(e.message ?? ''))
        .filter(Boolean)
    : []
  return { skills, errors }
}

/**
 * 目录只在真正需要时才拉：百炼那次列表要带鉴权、走外网，一个从来没用过技能的用户
 * 不该在打开页面时替所有人付这次请求（旧通道"按 18 个类目翻页"的代价已经不存在，但这条判断留着）。
 */
export function loadSkillCatalog(refresh = false): Promise<void> {
  if (!refresh && catalogPromise) return catalogPromise
  const task = (async () => {
    try {
      const { skills, errors } = toSummaries(
        await getJson(`/api/skills/catalog${refresh ? '?refresh=true' : ''}`),
      )
      catalogSkills = skills
      catalogErrors = errors
      catalogLoaded = true
      // 目录换了要把开关集里已经不存在的名字洗掉，否则索引会长期挂着一条取不到的技能
      if (skills.length > 0) {
        const known = new Set(skills.map((s) => s.name))
        const kept = enabledNames.filter((n) => known.has(n))
        if (kept.length !== enabledNames.length) setSkillEnabledAll(kept)
      }
    } catch (err) {
      console.warn('[skills] 目录加载失败:', (err as Error).message)
      catalogErrors = [(err as Error).message]
      // 失败要能再试：留着已 resolved 的 promise 就把面板的"重试"按钮变成永久空态
      catalogPromise = null
    }
    notifyStore()
  })()
  catalogPromise = task
  return task
}

function setSkillEnabledAll(names: string[]): void {
  enabledNames = names
  writeEnabledNames(names)
  notifyStore()
}

/** App 挂载时调：一个技能都没开着就不发请求。 */
export function loadSkillCatalogIfEnabled(): void {
  if (enabledNames.length > 0) void loadSkillCatalog()
}

export function getSkillCatalogState(): {
  skills: SkillSummary[]
  errors: string[]
  loaded: boolean
} {
  return { skills: catalogSkills, errors: catalogErrors, loaded: catalogLoaded }
}

export async function searchSkills(keyword: string, maxResults = 10): Promise<SkillSummary[]> {
  const trimmed = keyword.trim()
  if (!trimmed) return []
  const { skills } = toSummaries(
    await getJson(`/api/skills/search?keyword=${encodeURIComponent(trimmed)}&maxResults=${maxResults}`),
  )
  return skills
}

/** 开关集内、目录里能查到的那部分；`missing` 是开着但目录里没有的名字（上游改动或目录未加载）。 */
export function resolveEnabledSkills(names = enabledNames, skills = catalogSkills): {
  found: SkillSummary[]
  missing: string[]
} {
  const byName = new Map(skills.map((s) => [s.name, s]))
  const found: SkillSummary[] = []
  const missing: string[] = []
  for (const name of names) {
    const hit = byName.get(name)
    if (hit) found.push(hit)
    else missing.push(name)
  }
  return { found, missing }
}

/**
 * 常驻索引段。纯函数，不读模块状态 —— 预算行为要能单测断言，不能只靠"看起来没超"。
 *
 * 超预算的部分**不静默消失**：留一行说明还有多少个没列进来，并指向 skill_search。
 */
export function renderSkillIndex(
  entries: SkillSummary[],
  budget = SKILL_INDEX_BUDGET_CHARS,
): { text: string; included: number; omitted: number } {
  if (entries.length === 0) return { text: '', included: 0, omitted: 0 }

  const header = `\n\n可用技能（内置 / 百炼，已开 ${entries.length} 个）。用 skill_load(name) 取正文，正文里提到的 references/*.md 用 skill_file 读取。${GENERATE_ONLY_NOTICE}`
  const omission = (n: number) =>
    `\n另有 ${n} 个已开技能未列入目录（超出索引预算），用 skill_search 查找。`

  const lines: string[] = []
  let used = header.length
  let omitted = 0
  // 一律按"最坏那句提示"预留，宁可少列一条也不让整段超出预算：提示语是否会出现要等循环结束才知道，
  // 而预算溢出是这一整段每轮都重算时唯一会累积的代价。
  const reserve = omission(entries.length).length
  for (const entry of entries) {
    const line = `\n- [${SKILL_ORIGIN_TAGS[entry.origin]}] ${entry.name}: ${entry.description}`
    if (used + line.length + reserve > budget) {
      omitted = entries.length - lines.length
      break
    }
    lines.push(line)
    used += line.length
  }
  if (omitted > 0) lines.push(omission(omitted))
  return { text: header + lines.join(''), included: entries.length - omitted, omitted }
}

/**
 * 每轮重算（`buildSystemPrompt` 调），返回 '' 表示不注入该段。
 *
 * 判据与 `SOURCE.resolveEnabled` 是同一个 `enabledNames.length`：索引段在不在、
 * 三个 skill_* 工具进不进 definitions（`isSourceEnabled` 读的就是那份派生值），必须同开同关。
 * 09-19 那次实测到的"技能开关关了、索引段还在系统提示里"就是这两处各判一次造成的。
 */
export function buildSkillIndexSection(): string {
  if (enabledNames.length === 0) return ''
  const { found, missing } = resolveEnabledSkills()
  const { text } = renderSkillIndex(found)
  if (missing.length === 0) return text
  // 目录还没加载时开着技能却列不出来，这句是唯一的可观测痕迹，不能省
  return text + `\n（另有 ${missing.length} 个已开技能暂时查不到说明，稍后重试或用 skill_search 查找。）`
}

async function callText(path: string, fallback: string): Promise<ToolResult> {
  let data: unknown
  try {
    data = await getJson(path)
  } catch (err) {
    return { text: `技能服务调用失败：${(err as Error).message}`, isError: true }
  }
  const body = data as { text?: unknown; is_error?: unknown }
  const text = typeof body?.text === 'string' ? body.text : fallback
  return { text, isError: body?.is_error === true }
}

const SOURCE_OFF_RESULT: ToolResult = {
  text: '技能通道当前没有任何打开的技能：目录/正文/引用文件都取不到。要用的话请到技能面板里打开对应技能的开关。',
  isError: true,
}

/** 关掉的那一个要指名道姓地回：只说"未启用"的话，模型会以为是服务故障，然后去试第二个技能名。 */
function skillOffResult(name: string): ToolResult {
  return { text: `技能 ${name} 的开关没打开，取不到它的内容。请到技能面板里打开它，或换用已打开的技能。`, isError: true }
}

async function skillSearchTool(keyword: unknown, maxResults: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return SOURCE_OFF_RESULT
  const query = typeof keyword === 'string' ? keyword.trim() : ''
  if (!query) return { text: 'skill_search 需要非空的 keyword。', isError: true }
  const limit =
    typeof maxResults === 'number' && Number.isFinite(maxResults) ? Math.min(Math.max(maxResults, 1), 30) : 10
  let rows: SkillSummary[]
  try {
    rows = await searchSkills(query, limit)
  } catch (err) {
    return { text: `技能检索失败：${(err as Error).message}`, isError: true }
  }
  // 检索范围 = 打开的那些技能。它的用处不是"发现新技能"（那是面板的事），
  // 而是把超出常驻索引预算、没列进目录的那部分捞回来 —— 关掉的本就不该被调到，不该出现在结果里
  rows = rows.filter((r) => isSkillEnabled(r.name))
  if (rows.length === 0)
    return { text: `未检索到与「${query}」相关的技能（只有开关打开的技能可被检索，界面上还能看到全部目录）。`, isError: false }
  const listed = rows
    .map((r) => {
      const desc = r.description.length > 200 ? r.description.slice(0, 200) + '…（说明已截断，需要操作细节用 skill_load）' : r.description
      return `- ${r.name} [${SKILL_ORIGIN_TAGS[r.origin]}]: ${desc}`
    })
    .join('\n')
  const indexedNote =
    rows.filter((r) => resolveEnabledSkills([r.name]).found.length > 0).length > 0
      ? '\n\n（已在系统提示索引里的技能可直接 skill_load。）'
      : ''
  return { text: `检索「${query}」得到 ${rows.length} 个技能：\n${listed}${indexedNote}`, isError: false }
}

async function skillLoadTool(name: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return SOURCE_OFF_RESULT
  const skill = typeof name === 'string' ? name.trim() : ''
  if (!skill) return { text: 'skill_load 需要非空的 name（技能目录里的技能名）。', isError: true }
  if (!isSkillEnabled(skill)) return skillOffResult(skill)
  const res = await callText(`/api/skills/content?name=${encodeURIComponent(skill)}`, '(空结果)')
  if (res.isError) return res
  // 前言随正文一起落库、一起被回放：约束要贴着内容本身，而不是只在面板上写一次
  return { text: `【技能正文 ${skill}】${GENERATE_ONLY_NOTICE}\n\n${res.text}`, isError: false }
}

async function skillFileTool(name: unknown, path: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return SOURCE_OFF_RESULT
  const skill = typeof name === 'string' ? name.trim() : ''
  const ref = typeof path === 'string' ? path.trim() : ''
  if (!skill || !ref) {
    return { text: 'skill_file 需要 name 与 path，path 形如 references/ram-policies.md。', isError: true }
  }
  if (!isSkillEnabled(skill)) return skillOffResult(skill)
  const res = await callText(
    `/api/skills/file?name=${encodeURIComponent(skill)}&path=${encodeURIComponent(ref)}`,
    '(空结果)',
  )
  // 正文里 "见 references/xxx.md" 的引用可能与包内文件对不上，断链必须显式回给模型，别让它自己补一段
  if (res.isError) return { text: `${res.text}（该引用文件未找到，不要凭印象编造其内容。）`, isError: true }
  return res
}

registry.register(
  {
    name: 'skill_search',
    description: `按关键词在技能目录（内置 + 百炼）里匹配技能名与说明。${GENERATE_ONLY_NOTICE} 返回的是技能名与用途说明，不是执行结果。`,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '要匹配的关键词，中英文皆可，命中标题或说明即可' },
        maxResults: { type: 'number', description: '最多返回多少条，默认 10，上限 30' },
      },
      required: ['keyword'],
    },
  },
  { execute: (args) => skillSearchTool(args.keyword, args.maxResults) },
  { provider: 'skill', sourceId: SKILL_SOURCE_ID, durability: 'transient', effect: 'data' },
)

registry.register(
  {
    name: 'skill_load',
    description: `按 name 取一份技能正文（SKILL.md 全文，较长）。${GENERATE_ONLY_NOTICE} 正文里出现的命令行、脚本、SDK 调用一律转译成写给用户的产物与前置条件。`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill_search 或索引里的技能名' } },
      required: ['name'],
    },
  },
  { execute: (args) => skillLoadTool(args.name) },
  { provider: 'skill', sourceId: SKILL_SOURCE_ID, durability: 'durable', effect: 'instructions' },
)

registry.register(
  {
    name: 'skill_file',
    description: `读取某个技能包 references/ 目录下的一个 .md 引用文件（正文里以"见 references/xxx.md"形式提到的附属文件）。${GENERATE_ONLY_NOTICE} 只能读 references/ 下的 .md，取不到被截断的正文本身。`,
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名' },
        path: { type: 'string', description: 'references/ 开头的相对路径，如 references/ram-policies.md' },
      },
      required: ['name', 'path'],
    },
  },
  { execute: (args) => skillFileTool(args.name, args.path) },
  { provider: 'skill', sourceId: SKILL_SOURCE_ID, durability: 'transient', effect: 'data' },
)

applyProviderSources('skill', [SOURCE])
