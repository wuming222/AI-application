import type { Message, StreamChunk } from '../types'
import type { StreamChatOptions } from '../router'

const MOCK_RESPONSE = `你好！我是 AI 助手。这是一个 Mock 响应，用于在没有 API key 的情况下验证流式渲染链路。

你可以继续发送消息来测试多轮对话、停止按钮等功能。当配置好 .env 并切换 VITE_LLM_PROVIDER=openai 后，这里会显示真实模型的回复。`

export async function* streamMock(
  _messages: Message[],
  signal?: AbortSignal,
  _options?: StreamChatOptions,
): AsyncGenerator<StreamChunk> {
  const chars = [...MOCK_RESPONSE]
  for (let i = 0; i < chars.length; i++) {
    if (signal?.aborted) return
    yield { delta: chars[i], done: false }
    await new Promise((r) => setTimeout(r, 30))
  }
  yield { delta: '', done: true }
}
