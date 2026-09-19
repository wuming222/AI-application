import type { CapabilitySourceInfo } from '../types'
import { registry } from '../toolRegistry'
import type { ToolResult } from '../toolRegistry'
import { applyProviderSources, isSourceEnabled } from '../capabilityStore'

/**
 * skill provider：把阿里云 Agent Skills 目录接成第三个能力来源。
 *
 * 与 `providers/mcp.ts` 共用同一条管道（清单 → 注册 → 开关 → 面板 → 错误契约），
 * 差在两个语义上，这两处**不统一**是本特性的立论所在：
 * - MCP 工具返回的是**这一次的事实**（data / transient），压掉无所谓；
 * - `skill_load` 返回的是**之后每一轮都要遵守的操作手册**（instructions / durable），
 *   被上下文预算阶段一压掉就等于技能白接了 —— 所以它有 `contextBudget` 里的豁免额度。
 *
 * 三个工具的定义是**静态注册**的（模块导入即完成，不发请求），所以它们不占 K9 那场
 * 2s race：只有 MCP 的清单要等服务端逐 server 握手。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''

/** 后端 read 超时是 30s（app/skills/sources.py），这里必须严格大于它，否则先到的是 fetch 的 AbortError。 */
const REQUEST_TIMEOUT_MS = 35_000

export const SKILL_SOURCE_ID = 'agent-skills'
const SKILL_SOURCE_LABEL = '阿里云 Agent Skills'

/** 常驻索引整段的上界（K3：6,000 真 token @1.5 字符/token = softLimit 60,000 的 10%）。 */
export const SKILL_INDEX_BUDGET_CHARS = 9_000

/**
 * 勾选集是**全局偏好**（与 MCP 的开关同理：它不属于任何一条会话），
 * 但"这一轮注入了哪些正文"是会话状态 —— 正文作为 role:'tool' 消息落库。
 */
const SELECTED_KEY = 'skills-selected'

/** 面板、工具 description、正文前言三处共用的承诺，措辞保持一致才好核对。 */
export const GENERATE_ONLY_NOTICE =
  '本应用不执行任何命令：技能只提供规范与经验，据此产出交付物（代码、配置、Terraform、供用户自行执行的命令清单及其前置条件），不得声称已执行。'

export interface SkillSummary {
  name: string
  displayName: string
  description: string
  categoryCode?: string
}

const SOURCE: CapabilitySourceInfo = {
  id: SKILL_SOURCE_ID,
  label: SKILL_SOURCE_LABEL,
  kind: 'skill',
  // 与 MCP 那两个默认关的 server 相反：技能是纯只读知识，默认开着才有意义
  defaultEnabled: true,
}

let catalogSkills: SkillSummary[] = []
let catalogErrors: string[] = []
let catalogLoaded = false
let catalogPromise: Promise<void> | null = null

let selectedNames: string[] = readSelectedNames()
const storeListeners = new Set<() => void>()

function readSelectedNames(): string[] {
  try {
    const raw = localStorage.getItem(SELECTED_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return Array.from(new Set(parsed.filter((v): v is string => typeof v === 'string')))
  } catch {
    // 隐私模式 / 配额满 / 坏数据：当作没勾过，不值得为此中断生成
    return []
  }
}

function writeSelectedNames(names: string[]): void {
  try {
    localStorage.setItem(SELECTED_KEY, JSON.stringify(names))
  } catch {
    // 存不下就只活在这一页
  }
}

function notifyStore(): void {
  for (const fn of storeListeners) fn()
}

/** 面板订阅这一个就够：勾选集与目录状态的变化都走它。 */
export function subscribeSkillsStore(fn: () => void): () => void {
  storeListeners.add(fn)
  return () => storeListeners.delete(fn)
}

export function getSelectedSkillNames(): string[] {
  return selectedNames
}

export function isSkillSelected(name: string): boolean {
  return selectedNames.includes(name)
}

export function setSkillSelected(name: string, on: boolean): void {
  const next = on
    ? Array.from(new Set([...selectedNames, name]))
    : selectedNames.filter((n) => n !== name)
  if (next.length === selectedNames.length) return
  selectedNames = next
  writeSelectedNames(next)
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
          categoryCode: typeof r.categoryCode === 'string' ? r.categoryCode : undefined,
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
 * 目录只在真正需要时才拉：全量目录在服务端要按 18 个类目逐个翻页，
 * 一个从来没用过技能的用户不该在打开页面时替所有人付这次请求。
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
      // 目录换了要把勾选集里已经不存在的名字洗掉，否则索引会长期挂着一条取不到的技能
      if (skills.length > 0) {
        const known = new Set(skills.map((s) => s.name))
        const kept = selectedNames.filter((n) => known.has(n))
        if (kept.length !== selectedNames.length) setSkillSelectedAll(kept)
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

function setSkillSelectedAll(names: string[]): void {
  selectedNames = names
  writeSelectedNames(names)
  notifyStore()
}

/** App 挂载时调：没勾过任何技能就不发请求。 */
export function loadSkillCatalogIfSelected(): void {
  if (selectedNames.length > 0) void loadSkillCatalog()
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

/** 勾选集内、目录里能查到的那部分；`missing` 是勾了但目录没有的名字（上游改动或目录未加载）。 */
export function resolveSelectedSkills(names = selectedNames, skills = catalogSkills): {
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

  const header = `\n\n可参考的阿里云 Agent Skills（已选 ${entries.length} 个）。用 skill_load(name) 取正文，正文里提到的 references/*.md 用 skill_file 读取。${GENERATE_ONLY_NOTICE}`
  const omission = (n: number) =>
    `\n另有 ${n} 个已选技能未列入目录（超出索引预算），用 skill_search 查找。`

  const lines: string[] = []
  let used = header.length
  let omitted = 0
  // 一律按"最坏那句提示"预留，宁可少列一条也不让整段超出预算：提示语是否会出现要等循环结束才知道，
  // 而预算溢出是这一整段每轮都重算时唯一会累积的代价。
  const reserve = omission(entries.length).length
  for (const entry of entries) {
    const line = `\n- ${entry.name}: ${entry.description}`
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

/** 每轮重算（`buildSystemPrompt` 调），返回 '' 表示不注入该段。 */
export function buildSkillIndexSection(): string {
  if (selectedNames.length === 0) return ''
  const { found, missing } = resolveSelectedSkills()
  const { text } = renderSkillIndex(found)
  if (missing.length === 0) return text
  // 目录还没加载时勾了技能却列不出来，这句是唯一的可观测痕迹，不能省
  return text + `\n（另有 ${missing.length} 个已选技能暂时查不到说明，稍后重试或用 skill_search 查找。）`
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

const DISABLED_RESULT: ToolResult = {
  text: `能力未启用：${SKILL_SOURCE_LABEL} 当前在能力面板里是关闭状态，技能目录/正文/引用文件都取不到。`,
  isError: true,
}

async function skillSearchTool(keyword: unknown, maxResults: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return DISABLED_RESULT
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
  if (rows.length === 0) return { text: `未检索到与「${query}」相关的技能。`, isError: false }
  const listed = rows
    .map((r) => {
      const desc = r.description.length > 200 ? r.description.slice(0, 200) + '…（说明已截断，需要操作细节用 skill_load）' : r.description
      return `- ${r.name}${r.categoryCode ? ` [${r.categoryCode}]` : ''}: ${desc}`
    })
    .join('\n')
  const selectedNote =
    rows.filter((r) => isSkillSelected(r.name)).length > 0
      ? '\n\n（标注为已选的技能已在系统提示的索引里，可直接 skill_load。）'
      : ''
  return { text: `检索「${query}」得到 ${rows.length} 个技能：\n${listed}${selectedNote}`, isError: false }
}

async function skillLoadTool(name: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return DISABLED_RESULT
  const skill = typeof name === 'string' ? name.trim() : ''
  if (!skill) return { text: 'skill_load 需要非空的 name（技能目录里的 skillName）。', isError: true }
  const res = await callText(`/api/skills/content?name=${encodeURIComponent(skill)}`, '(空结果)')
  if (res.isError) return res
  // 前言随正文一起落库、一起被回放：约束要贴着内容本身，而不是只在面板上写一次
  return { text: `【技能正文 ${skill}】${GENERATE_ONLY_NOTICE}\n\n${res.text}`, isError: false }
}

async function skillFileTool(name: unknown, path: unknown): Promise<ToolResult> {
  if (!isSourceEnabled(SKILL_SOURCE_ID)) return DISABLED_RESULT
  const skill = typeof name === 'string' ? name.trim() : ''
  const ref = typeof path === 'string' ? path.trim() : ''
  if (!skill || !ref) {
    return { text: 'skill_file 需要 name 与 path，path 形如 references/ram-policies.md。', isError: true }
  }
  const res = await callText(
    `/api/skills/file?name=${encodeURIComponent(skill)}&path=${encodeURIComponent(ref)}`,
    '(空结果)',
  )
  // 实测正文里 15% 的 references 引用在包里对不上文件，断链必须显式回给模型，别让它自己补一段
  if (res.isError) return { text: `${res.text}（该引用文件未找到，不要凭印象编造其内容。）`, isError: true }
  return res
}

registry.register(
  {
    name: 'skill_search',
    description: `${SKILL_SOURCE_LABEL} 目录检索（语义匹配）。${GENERATE_ONLY_NOTICE} 返回的是技能名与用途说明，不是执行结果。`,
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '自然语言需求，中英文皆可' },
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
    description: `按 name 取一份技能正文（SKILL.md 全文，较长）。${GENERATE_ONLY_NOTICE} 正文里的 aliyun CLI / 脚本 / Terraform 调用一律转译成写给用户的产物与前置条件。`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'skill_search 或索引里的 skillName' } },
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
