import type { AgentToolCallInfo } from './types'

export interface ToolCallPatch {
  callId?: string
  name: string
  args?: Record<string, unknown>
  status?: AgentToolCallInfo['status']
}

// 内置工具没有 callId，退化成按名字对齐；函数调用一律有 callId。
function keyOf(tool: { callId?: string; name: string }): string {
  return tool.callId ?? tool.name
}

// 进度行只前进不后退：参数还在流的时候可能收到多次快照，
// 不能把已经执行完的行打回 running，否则界面上的 ✓ 会闪掉。
const RANK: Record<AgentToolCallInfo['status'], number> = { running: 0, done: 1, error: 1 }

/**
 * 把新一批工具状态合并进已有进度行：按 callId 对齐、新的追加、已有的不重置。
 * 返回新数组，status 缺省为 running。
 */
export function mergeToolCalls(
  existing: AgentToolCallInfo[] | undefined,
  patches: ToolCallPatch[],
): AgentToolCallInfo[] {
  const merged: AgentToolCallInfo[] = (existing ?? []).map((tool) => ({ ...tool }))

  for (const patch of patches) {
    const key = keyOf(patch)
    const row = merged.find((tool) => keyOf(tool) === key)
    const args = patch.args && Object.keys(patch.args).length > 0 ? patch.args : undefined

    if (!row) {
      merged.push({
        callId: patch.callId,
        name: patch.name,
        args: args ?? {},
        status: patch.status ?? 'running',
      })
      continue
    }

    if (args) row.args = args
    const next = patch.status ?? 'running'
    if (RANK[next] >= RANK[row.status]) row.status = next
  }

  return merged
}
