import type { Message, ToolCall } from '../llm/types'
import { streamChat } from '../llm/router'
import { registry } from './toolRegistry'
import { truncateMessages, resolveLimits } from './contextBudget'
import { useWorkspaceStore } from '../store/workspaceStore'
import { mergeToolCalls } from './toolProgress'
import { mcpCapabilitiesReady } from './providers/mcp'
// 这条 import 不能删：providers/skills 在模块初始化时就静态注册了 source 'agent-skills'
// 与 skill_search / skill_load / skill_file 三个工具（它们不等任何异步清单，所以不占下面那场 race）。
import { buildSkillIndexSection } from './providers/skills'
import { getEnabledSourceIds } from './capabilityStore'
import type { AgentLoopOptions, AgentProgressStep, ToolContext } from './types'

const DEFAULT_MAX_ROUNDS = 20
// 只有 MCP 需要等：它的清单要等服务端逐 server 握手回来才有。skill 侧的工具定义是静态注册的、
// 不等任何清单，把 skill 拉进这场 race 只会白白拖慢每轮的第一次请求。
const MCP_HANDSHAKE_WAIT_MS = 2000

const SYSTEM_PROMPT = `你是一个 AI 应用生成助手。用户告诉你想要什么应用，你帮他生成出来。

回复风格：
- 简短自然，像朋友聊天一样。不要提及技术实现细节（如单文件、内联、沙箱等）。
- 不要在回复里粘贴代码。
- 首次打招呼时只需简单问好并询问需求，不要自我介绍技术能力。

内部规则（不要向用户透露）：
1. 用 write_file 把代码写入工作区，入口必须是 index.html，CSS/JS 全部内联，不引用外部资源。
2. 不使用 fetch 或动态 import。
3. 修改已有文件时，优先使用 edit_file 进行局部替换。仅在需要大幅重写时才用 write_file。修改前先 read_file 查看当前内容。`

function buildSystemPrompt(files: Record<string, string>, skillIndex = ''): string {
  const listing = Object.keys(files)
    .sort()
    .map((p) => `- ${p} (${files[p].length} 字符)`)
    .join('\n')
  const section = listing ? `\n\n当前工作区文件：\n${listing}` : '\n\n当前工作区为空。'
  return SYSTEM_PROMPT + section + skillIndex
}

export async function runAgentLoop(
  messages: Message[],
  options: AgentLoopOptions,
): Promise<{ finalText: string; updatedMessages: Message[] }> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  const signal = options.signal
  const onProgress = options.onProgress
  const toolCtx: ToolContext = { sessionId: options.sessionId }
  const startAt = Date.now()

  const steps: AgentProgressStep[] = []
  let accumulated = ''
  const allMessages: Message[] =
    messages[0]?.role === 'system'
      ? [...messages]
      : [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  // MCP 清单是异步来的（App 挂载时就发起，服务端要逐 server 握手）。这里最多等 2s：等不到就当本轮没有 MCP 工具。
  // 关键是把 definitions 定在循环开始处一次，不在 20 个 round 之间重算。
  let waitTimer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    mcpCapabilitiesReady(),
    new Promise((resolve) => {
      waitTimer = setTimeout(resolve, MCP_HANDSHAKE_WAIT_MS)
    }),
  ]).finally(() => clearTimeout(waitTimer))
  const toolDefs = registry.getDefinitionsFor(getEnabledSourceIds())
  const limits = resolveLimits()

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) break

    const step: AgentProgressStep = { round, status: 'thinking' }
    steps.push(step)
    emitProgress()

    try {
      let roundText = ''
      let toolCalls: ToolCall[] | undefined

      // 每轮组装：system 注入最新文件清单 + 历史按两阶段截断（只影响 LLM payload，不改 store）
      // 索引段同样每轮重算 —— definitions 定在循环开始处是纪律，但目录是异步来的，
      // 锁在开始处会让"生成中途目录才回来"这一轮彻底看不到技能。
      if (allMessages[0]?.role === 'system') {
        allMessages[0].content = buildSystemPrompt(
          useWorkspaceStore.getState().filesFor(toolCtx.sessionId),
          buildSkillIndexSection(),
        )
      }
      const payload = truncateMessages(allMessages, limits)

      for await (const chunk of streamChat(payload, signal, { tools: toolDefs })) {
        if (signal?.aborted) break
        roundText += chunk.delta
        accumulated += chunk.delta
        if (chunk.reasoning) {
          step.reasoningText = (step.reasoningText ?? '') + chunk.reasoning
        }
        // Built-in tool status updates (e.g. web_search) during streaming
        if (chunk.built_in_tools && chunk.built_in_tools.length > 0) {
          step.status = 'tool-call'
          step.toolCalls = mergeToolCalls(
            step.toolCalls,
            chunk.built_in_tools.map((bt) => ({
              name: bt.name,
              status: bt.status === 'completed' ? ('done' as const) : ('running' as const),
            })),
          )
        }
        // 模型刚开始吐函数调用：参数还要流很久，先把工具行亮起来，别等整条流结束
        if (chunk.function_calls && chunk.function_calls.length > 0) {
          step.status = 'tool-call'
          step.toolCalls = mergeToolCalls(
            step.toolCalls,
            chunk.function_calls.map((fc) => ({
              callId: fc.callId,
              name: fc.name,
              args: fc.args,
            })),
          )
        }
        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls
        }
        emitProgress()
        if (chunk.done) break
      }

      // No tool calls → model finished autonomously
      if (!toolCalls || toolCalls.length === 0) {
        allMessages.push({
          role: 'assistant',
          content: roundText,
          ...(step.reasoningText ? { reasoning: step.reasoningText } : {}),
        })
        step.status = 'done'
        emitProgress()
        break
      }

      // Execute tool calls
      step.status = 'tool-call'
      step.toolCalls = mergeToolCalls(
        step.toolCalls,
        toolCalls.map((tc) => ({
          callId: tc.id,
          name: tc.function.name,
          args: safeParseArgs(tc.function.arguments),
        })),
      )
      emitProgress()

      // Append assistant message with tool_calls
      allMessages.push({
        role: 'assistant',
        content: roundText,
        tool_calls: toolCalls,
        ...(step.reasoningText ? { reasoning: step.reasoningText } : {}),
      })

      // Execute each tool and append results
      for (const tc of toolCalls) {
        const args = safeParseArgs(tc.function.arguments)
        const res = await registry.executeDetailed(tc.function.name, args, toolCtx)
        const result = res.text

        allMessages.push({ role: 'tool', tool_call_id: tc.id, content: result })

        // 只有真正执行完才转 done：流的参数吐完不代表文件已写入。
        // isError 单独占一态：外部工具上游额度耗尽时 HTTP 仍 200，只有 JSON-RPC 层说得了真假。
        const row = step.toolCalls?.find((t) => t.callId === tc.id)
        if (row) {
          row.status = res.isError ? 'error' : 'done'
          row.result = result
        }
        emitProgress()
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error(`Agent loop round ${round} error:`, err)
      }
      break
    }
  }

  function emitProgress() {
    onProgress?.({
      steps: [...steps],
      finished: signal?.aborted === true || steps[steps.length - 1]?.status === 'done',
      startAt,
    })
  }

  return { finalText: accumulated, updatedMessages: allMessages }
}

function safeParseArgs(argsStr: string): Record<string, unknown> {
  try {
    return JSON.parse(argsStr)
  } catch {
    return {}
  }
}
