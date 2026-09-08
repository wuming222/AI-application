import { useState, useRef, useEffect } from 'react'
import { useChatStore } from '../store/chatStore'

export function ChatInterface() {
  const [input, setInput] = useState('')
  const { isStreaming, sendMessage, abort } = useChatStore()
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isStreaming) inputRef.current?.focus()
  }, [isStreaming])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!input.trim() || isStreaming) return
    sendMessage(input)
    setInput('')
  }

  return (
    <form onSubmit={handleSubmit} style={{ padding: '12px 16px', borderTop: '1px solid #eee' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        background: '#f5f5f5', borderRadius: 24, padding: '4px 4px 4px 16px',
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="输入消息..."
          disabled={isStreaming}
          style={{
            flex: 1, border: 'none', outline: 'none', background: 'transparent',
            fontSize: 14, padding: '8px 0', minWidth: 0,
          }}
        />
        {isStreaming ? (
          <button type="button" onClick={abort} style={{
            padding: '8px 20px', border: 'none', borderRadius: 20, cursor: 'pointer',
            background: '#ef4444', color: '#fff', fontSize: 14, fontWeight: 500,
            whiteSpace: 'nowrap',
          }}>
            停止
          </button>
        ) : (
          <button type="submit" disabled={isStreaming} style={{
            padding: '8px 20px', border: 'none', borderRadius: 20, cursor: 'pointer',
            background: '#1a73e8', color: '#fff', fontSize: 14, fontWeight: 500,
            whiteSpace: 'nowrap', opacity: isStreaming ? 0.5 : 1,
          }}>
            发送
          </button>
        )}
      </div>
    </form>
  )
}
