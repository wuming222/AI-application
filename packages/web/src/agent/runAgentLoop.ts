import type { Message } from '../llm/types'
import { streamChat } from '../llm/router'
import type { AgentLoopOptions, AgentProgress, AgentProgressStep } from './types'

export async function runAgentLoop(
  messages: Message[],
  options?: AgentLoopOptions,
): Promise<{ finalText: string; updatedMessages: Message[] }> {
  const maxRounds = options?.maxRounds ?? 3
  const signal = options?.signal
  const onProgress = options?.onProgress
  const startAt = Date.now()

  const steps: AgentProgressStep[] = []
  let accumulated = ''
  const allMessages: Message[] = [...messages]

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) break

    const step: AgentProgressStep = { round, thinkingText: '', status: 'thinking' }
    steps.push({ ...step })
    emitProgress()

    try {
      let roundText = ''
      for await (const chunk of streamChat(allMessages, signal)) {
        if (signal?.aborted) break
        roundText += chunk.delta
        accumulated += chunk.delta
        step.thinkingText = accumulated
        emitProgress()
        if (chunk.done) break
      }

      // Append assistant reply to messages for next round context
      allMessages.push({ role: 'assistant', content: roundText })

      step.status = 'done'
      emitProgress()
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
      finished: signal?.aborted === true || steps.length >= maxRounds,
      startAt,
    })
  }

  return { finalText: accumulated, updatedMessages: allMessages }
}
