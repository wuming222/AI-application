import type { Message, ToolCall } from '../llm/types'
import { streamChat } from '../llm/router'
import { registry } from './toolRegistry'
import type { AgentLoopOptions, AgentProgress, AgentProgressStep, AgentToolCallInfo } from './types'

const DEFAULT_MAX_ROUNDS = 20

const SYSTEM_PROMPT = `你是 AI 应用生成器，运行在浏览器内的虚拟工作区中。

工作规则：
1. 用户描述需求后，使用 write_file 工具把代码写入虚拟工作区，然后简短说明你做了什么。
2. 生成的网页应用必须以 index.html 为入口。CSS 和 JavaScript 全部内联在这个文件里，不要拆分文件，不要引用外部资源（CDN、图片外链等）。
3. 不使用 fetch 或动态 import——预览环境是自包含沙箱，无法发起网络请求。
4. 用户要求修改时，先用 read_file 或 list_files 查看现状，再用 write_file 写入完整的新版本文件。
5. 最终回复保持简短，不要在回复里粘贴大段代码。`

export async function runAgentLoop(
  messages: Message[],
  options?: AgentLoopOptions,
): Promise<{ finalText: string; updatedMessages: Message[] }> {
  const maxRounds = options?.maxRounds ?? DEFAULT_MAX_ROUNDS
  const signal = options?.signal
  const onProgress = options?.onProgress
  const startAt = Date.now()

  const steps: AgentProgressStep[] = []
  let accumulated = ''
  const allMessages: Message[] =
    messages[0]?.role === 'system'
      ? [...messages]
      : [{ role: 'system', content: SYSTEM_PROMPT }, ...messages]
  const toolDefs = registry.getDefinitions()

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) break

    const step: AgentProgressStep = { round, thinkingText: '', status: 'thinking' }
    steps.push({ ...step })
    emitProgress()

    try {
      let roundText = ''
      let toolCalls: ToolCall[] | undefined

      for await (const chunk of streamChat(allMessages, signal, { tools: toolDefs })) {
        if (signal?.aborted) break
        roundText += chunk.delta
        accumulated += chunk.delta
        step.thinkingText = accumulated
        if (chunk.tool_calls) {
          toolCalls = chunk.tool_calls
        }
        emitProgress()
        if (chunk.done) break
      }

      // No tool calls → model finished autonomously
      if (!toolCalls || toolCalls.length === 0) {
        allMessages.push({ role: 'assistant', content: roundText })
        step.status = 'done'
        emitProgress()
        break
      }

      // Execute tool calls
      step.status = 'tool-call'
      step.toolCalls = toolCalls.map((tc) => ({
        name: tc.function.name,
        args: safeParseArgs(tc.function.arguments),
        status: 'running' as const,
      }))
      emitProgress()

      // Append assistant message with tool_calls
      allMessages.push({ role: 'assistant', content: roundText, tool_calls: toolCalls })

      // Execute each tool and append results
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        const args = safeParseArgs(tc.function.arguments)
        const result = await registry.execute(tc.function.name, args)

        allMessages.push({ role: 'tool', tool_call_id: tc.id, content: result })

        if (step.toolCalls) {
          step.toolCalls[i].status = 'done'
          step.toolCalls[i].result = result
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
