import { Fragment, useRef, useEffect } from 'react'
import type { SyntheticEvent } from 'react'
import { Empty } from 'antd'
import ReactMarkdown from 'react-markdown'
import './MessageList.css'
import { useChatStore } from '../store/chatStore'
import { useSessionStore } from '../store/sessionStore'
import { AgentProgress } from './AgentProgress'
import type { Message, ToolCall } from '../llm/types'

const NO_MESSAGES: Message[] = []

function toggleIntoView(e: SyntheticEvent<HTMLDetailsElement>) {
  if (e.currentTarget.open) {
    e.currentTarget.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
}

function isDisplayable(msg: Message): boolean {
  if (msg.role === 'system' || msg.role === 'tool') return false
  if (msg.role === 'user') return true
  return msg.content !== '' || (msg.tool_calls?.length ?? 0) > 0
}

// 展示用的字符串截断，避免大参数/大结果撑爆气泡
function capText(s: string, cap: number): string {
  return s.length > cap ? s.slice(0, cap) + `…（共 ${s.length} 字符）` : s
}

function prettyArgs(argsJson: string): string {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>
    if (obj && typeof obj === 'object') {
      const summarized = Object.fromEntries(
        Object.entries(obj).map(([k, v]) => [k, typeof v === 'string' ? capText(v, 300) : v]),
      )
      return JSON.stringify(summarized, null, 2)
    }
    return argsJson
  } catch {
    return capText(argsJson, 300)
  }
}

// 三级结构：二级=工具行（summary），三级=入参与执行结果
function ToolItem({ tc, result }: { tc: ToolCall; result?: string }) {
  let path = ''
  try {
    path = (JSON.parse(tc.function.arguments) as { path?: string }).path ?? ''
  } catch {
    // malformed args — show tool name only
  }
  return (
    <details onToggle={toggleIntoView} className="tool-item">
      <summary className="tool-item-summary">
        🔧 {tc.function.name}
        {path && `: ${path}`}
      </summary>
      <div className="tool-item-detail">
        <div>入参：{prettyArgs(tc.function.arguments)}</div>
        <div className="tool-item-result">结果：{result === undefined ? '（无返回）' : capText(result, 1000)}</div>
      </div>
    </details>
  )
}

// 一次任务的多轮工具调用在渲染层合并为一个气泡（store 里的消息结构保持 LLM 原始历史不变）
type Item = { type: 'msg'; msg: Message } | { type: 'toolGroup'; msgs: Message[] }

function buildItems(messages: Message[]): Item[] {
  const items: Item[] = []
  for (const msg of messages) {
    if (!isDisplayable(msg)) continue
    const isToolRound = msg.role === 'assistant' && (msg.tool_calls?.length ?? 0) > 0
    const last = items[items.length - 1]
    if (isToolRound) {
      if (last?.type === 'toolGroup') last.msgs.push(msg)
      else items.push({ type: 'toolGroup', msgs: [msg] })
    } else {
      items.push({ type: 'msg', msg })
    }
  }
  return items
}

function ToolGroupBubble({ msgs, toolResults }: { msgs: Message[]; toolResults: Map<string, string> }) {
  const totalCalls = msgs.reduce((n, m) => n + (m.tool_calls?.length ?? 0), 0)
  return (
    <div className="tool-bubble">
      <details open>
        <summary className="tool-bubble-summary">
          🔧 执行工具 {totalCalls} 次
        </summary>
        {msgs.map((m, i) => (
          <Fragment key={i}>
            {m.content && <div className="tool-round-text">{m.content}</div>}
            {m.tool_calls!.map((tc, j) => (
              <ToolItem key={tc.id || j} tc={tc} result={toolResults.get(tc.id)} />
            ))}
          </Fragment>
        ))}
      </details>
    </div>
  )
}

export function MessageList() {
  const currentSessionId = useSessionStore((s) => s.currentSessionId)
  const slice = useChatStore((s) => (currentSessionId ? s.bySession[currentSessionId] : undefined))
  const messages = slice?.messages ?? NO_MESSAGES
  const isStreaming = slice?.isStreaming ?? false
  const progress = slice?.progress ?? null
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, progress])

  const toolResults = new Map(
    messages
      .filter((m) => m.role === 'tool' && m.tool_call_id)
      .map((m) => [m.tool_call_id as string, m.content]),
  )

  return (
    <div className="message-list">
      {messages.length === 0 && !isStreaming && (
        <div className="message-list-empty">
          <Empty description="发送一条消息开始对话" />
        </div>
      )}
      {buildItems(messages).map((item, i) =>
        item.type === 'toolGroup' ? (
          <ToolGroupBubble key={i} msgs={item.msgs} toolResults={toolResults} />
        ) : (
          <div key={i} className={`message-bubble message-bubble-${item.msg.role}`}>
            <div className="message-markdown">
              <ReactMarkdown>{item.msg.content}</ReactMarkdown>
            </div>
            {item.msg.images && item.msg.images.length > 0 && (
              <div className="message-images">
                {item.msg.images.map((src, j) => (
                  <img key={j} src={src} alt="" className="message-image" />
                ))}
              </div>
            )}
          </div>
        ),
      )}
      {isStreaming && progress && <AgentProgress progress={progress} />}
      <div ref={bottomRef} />
    </div>
  )
}
