import type { CapabilityKind, CapabilitySourceInfo, CapabilitySnapshot } from './types'

/**
 * 能力（capability）在前端的**唯一状态源**：清单 + 逐 source 开关 + 快照订阅。
 *
 * provider 无关 —— MCP 与 skill 各自去 `providers/*.ts` 里拉清单，再 `applyProviderSources`
 * 把结果换进来。这里不碰网络、不碰 registry、不认识任何一个具体工具。
 *
 * 开关是**全局偏好**（localStorage），不是会话状态：它不进 chatStore.bySession、不落库。
 * 因此生成中途翻开关不影响在飞的那一轮（definitions 在每次 runAgentLoop 开始处只读一次），
 * 下一轮才生效。
 */

const ENABLEMENT_KEY = 'capabilities-enabled'
/** 能力抽象之前只有 MCP 一家，那份开关值要原样搬过来，不能让老用户一觉醒来开关全复位。 */
const LEGACY_ENABLEMENT_KEY = 'mcp-servers-enabled'

let sources: CapabilitySourceInfo[] = []
let snapshot: CapabilitySnapshot = { sources, enabled: {} }

const listeners = new Set<() => void>()

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // 隐私模式 / 配额满：读不到就当没有，退回 provider 下发的默认值
    return null
  }
}

function coerceBooleans(parsed: unknown): Record<string, boolean> {
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Record<string, boolean> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v === 'boolean') out[k] = v
  }
  return out
}

function readOverrides(): Record<string, boolean> {
  const raw = readItem(ENABLEMENT_KEY)
  if (!raw) return {}
  try {
    return coerceBooleans(JSON.parse(raw))
  } catch {
    return {}
  }
}

function writeOverrides(overrides: Record<string, boolean>): void {
  try {
    localStorage.setItem(ENABLEMENT_KEY, JSON.stringify(overrides))
  } catch {
    // 存不下就只活在这一页
  }
}

/** 一次性迁移：旧 key 并入新 key（新 key 已有的值赢），随后删掉旧 key。 */
function migrateLegacyOverrides(): void {
  let raw: string | null
  try {
    raw = localStorage.getItem(LEGACY_ENABLEMENT_KEY)
  } catch {
    return
  }
  if (raw === null) return

  let legacy: Record<string, boolean> = {}
  try {
    legacy = coerceBooleans(JSON.parse(raw))
  } catch {
    // 坏数据不值得留
  }
  const merged = { ...legacy, ...readOverrides() }
  if (Object.keys(merged).length > 0) writeOverrides(merged)
  try {
    localStorage.removeItem(LEGACY_ENABLEMENT_KEY)
  } catch {
    // 删不掉也只是下次再搬一遍，幂等
  }
}

function recompute(): void {
  const overrides = readOverrides()
  const enabled: Record<string, boolean> = {}
  for (const s of sources) enabled[s.id] = overrides[s.id] ?? s.defaultEnabled
  snapshot = { sources: [...sources], enabled }
}

function notify(): void {
  for (const fn of listeners) fn()
}

migrateLegacyOverrides()
recompute()

export function subscribeCapabilities(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** useSyncExternalStore 的快照：引用只在清单/翻开关时换，避免每次读都触发重渲染。 */
export function getCapabilitySnapshot(): CapabilitySnapshot {
  return snapshot
}

export function isSourceEnabled(id: string): boolean {
  return snapshot.enabled[id] === true
}

export function getEnabledSourceIds(): Set<string> {
  return new Set(Object.keys(snapshot.enabled).filter((id) => snapshot.enabled[id]))
}

export function setSourceEnabled(id: string, on: boolean): void {
  writeOverrides({ ...readOverrides(), [id]: on })
  recompute()
  notify()
}

/**
 * 按 kind **整组**替换该 provider 的清单（幂等，重复下发不会累积）。
 * 一个 provider 拉清单失败时要能把它名下所有 source 清空 —— 所以这里传空数组是合法的"清空"语义。
 */
export function applyProviderSources(kind: CapabilityKind, next: CapabilitySourceInfo[]): void {
  sources = [...sources.filter((s) => s.kind !== kind), ...next]
  recompute()
  notify()
}
