import { useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'

export function MessageList() {
  const messages = useChatStore((s) => s.messages)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {messages.length === 0 && (
        <div style={{ color: '#999', textAlign: 'center', marginTop: 40 }}>
          发送一条消息开始对话
        </div>
      )}
      {messages.map((msg, i) => (
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
          {msg.content || (msg.role === 'assistant' ? '...' : '')}
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
