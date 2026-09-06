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
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8, padding: 16 }}>
      <input
        ref={inputRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        placeholder="输入消息..."
        disabled={isStreaming}
        style={{ flex: 1, padding: '8px 12px', fontSize: 14 }}
      />
      {isStreaming ? (
        <button type="button" onClick={abort} style={{ padding: '8px 16px' }}>
          停止
        </button>
      ) : (
        <button type="submit" disabled={!input.trim()} style={{ padding: '8px 16px' }}>
          发送
        </button>
      )}
    </form>
  )
}
