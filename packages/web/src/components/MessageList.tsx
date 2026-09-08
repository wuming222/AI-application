import { Fragment, useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import { AgentProgress } from './AgentProgress'
import type { Message, ToolCall } from '../llm/types'

function isDisplayable(msg: Message): boolean {
  if (msg.role === 'system' || msg.role === 'tool') return false
  if (msg.role === 'user') return true
  return msg.content !== '' || (msg.tool_calls?.length ?? 0) > 0 || !!msg.reasoning
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
    <details style={{ marginLeft: 16, marginBottom: 2 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
        🔧 {tc.function.name}
        {path && `: ${path}`}
      </summary>
      <div style={{ marginLeft: 16, fontSize: 12, color: '#666', whiteSpace: 'pre-wrap', marginTop: 4 }}>
        <div>入参：{prettyArgs(tc.function.arguments)}</div>
        <div style={{ marginTop: 4 }}>结果：{result === undefined ? '（无返回）' : capText(result, 1000)}</div>
      </div>
    </details>
  )
}

function ReasoningDetails({ reasoning, hasContent }: { reasoning: string; hasContent: boolean }) {
  return (
    <details style={{ marginBottom: hasContent ? 6 : 0, color: '#999' }}>
      <summary style={{ cursor: 'pointer', fontSize: 12 }}>思考过程</summary>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 12, marginTop: 4 }}>{reasoning}</div>
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
    <div
      style={{
        alignSelf: 'flex-start',
        maxWidth: '75%',
        padding: '10px 14px',
        borderRadius: 12,
        backgroundColor: '#f0f0f0',
        color: '#333',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        lineHeight: 1.5,
      }}
    >
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>🔧 执行工具 {totalCalls} 次</div>
      {msgs.map((m, i) => (
        <Fragment key={i}>
          {m.content && <div style={{ marginBottom: 4 }}>{m.content}</div>}
          {m.tool_calls!.map((tc, j) => (
            <ToolItem key={tc.id || j} tc={tc} result={toolResults.get(tc.id)} />
          ))}
        </Fragment>
      ))}
    </div>
  )
}

export function MessageList() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const progress = useChatStore((s) => s.progress)
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
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {messages.length === 0 && (
        <div style={{ color: '#999', textAlign: 'center', marginTop: 40 }}>
          发送一条消息开始对话
        </div>
      )}
      {buildItems(messages).map((item, i) =>
        item.type === 'toolGroup' ? (
          <ToolGroupBubble key={i} msgs={item.msgs} toolResults={toolResults} />
        ) : (
          <div
            key={i}
            style={{
              alignSelf: item.msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '75%',
              padding: '10px 14px',
              borderRadius: 12,
              backgroundColor: item.msg.role === 'user' ? '#007bff' : '#f0f0f0',
              color: item.msg.role === 'user' ? '#fff' : '#333',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.5,
            }}
          >
            {item.msg.reasoning && (
              <ReasoningDetails reasoning={item.msg.reasoning} hasContent={!!item.msg.content} />
            )}
            {item.msg.content}
          </div>
        ),
      )}
      {isStreaming && progress && <AgentProgress progress={progress} />}
      <div ref={bottomRef} />
    </div>
  )
}
