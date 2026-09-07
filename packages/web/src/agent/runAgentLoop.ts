import type { Message, ToolCall } from '../llm/types'
import { streamChat } from '../llm/router'
import { registry } from './toolRegistry'
import type { AgentLoopOptions, AgentProgress, AgentProgressStep, AgentToolCallInfo } from './types'

const DEFAULT_MAX_ROUNDS = 20

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
  const allMessages: Message[] = [...messages]
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
