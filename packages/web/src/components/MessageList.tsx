import { useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'
import { AgentProgress } from './AgentProgress'
import type { Message } from '../llm/types'

function isDisplayable(msg: Message): boolean {
  if (msg.role === 'system' || msg.role === 'tool') return false
  if (msg.role === 'user') return true
  return msg.content !== '' || (msg.tool_calls?.length ?? 0) > 0 || !!msg.reasoning
}

function ToolCallSummary({ toolCalls }: { toolCalls: NonNullable<Message['tool_calls']> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 13 }}>
      {toolCalls.map((tc, i) => {
        let path = ''
        try {
          path = (JSON.parse(tc.function.arguments) as { path?: string }).path ?? ''
        } catch {
          // malformed args — show tool name only
        }
        return (
          <span key={tc.id || i}>
            🔧 {tc.function.name}
            {path && `: ${path}`}
          </span>
        )
      })}
    </div>
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

export function MessageList() {
  const messages = useChatStore((s) => s.messages)
  const isStreaming = useChatStore((s) => s.isStreaming)
  const progress = useChatStore((s) => s.progress)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, progress])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {messages.length === 0 && (
        <div style={{ color: '#999', textAlign: 'center', marginTop: 40 }}>
          发送一条消息开始对话
        </div>
      )}
      {messages.filter(isDisplayable).map((msg, i) => (
        <div
          key={i}
          style={{
            alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
            maxWidth: '75%',
            padding: '10px 14px',
            borderRadius: 12,
            backgroundColor: msg.role === 'user' ? '#007bff' : '#f0f0f0',
            color: msg.role === 'user' ? '#fff' : '#333',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            lineHeight: 1.5,
          }}
        >
          {msg.role === 'assistant' && msg.tool_calls?.length ? (
            <ToolCallSummary toolCalls={msg.tool_calls} />
          ) : null}
          {msg.reasoning && <ReasoningDetails reasoning={msg.reasoning} hasContent={!!msg.content} />}
          {msg.content}
        </div>
      ))}
      {isStreaming && progress && <AgentProgress progress={progress} />}
      <div ref={bottomRef} />
    </div>
  )
}
