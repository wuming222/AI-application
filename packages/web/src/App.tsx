import { useState, useCallback, useRef, useEffect } from 'react'
import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'
import { PreviewArea } from './components/PreviewArea'
import { Sidebar } from './components/Sidebar'

export default function App() {
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback(() => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }, [])

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return
      const rect = containerRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const min = 320
      const max = rect.width - 320
      setChatWidth(Math.max(min, Math.min(max, x)))
    }
    const onMouseUp = () => {
      if (dragging.current) {
        dragging.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
      }
    }
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    return () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      <Sidebar />
      <div ref={containerRef} style={{ display: 'flex', flex: 1, minWidth: 0 }}>
        <div style={{
          display: 'flex', flexDirection: 'column', minWidth: 0,
          width: chatWidth ?? undefined,
          flex: chatWidth === null ? 1 : undefined,
        }}>
          <header style={{ padding: '12px 16px', borderBottom: '1px solid #eee', fontWeight: 600 }}>
            AI App Generator
          </header>
          <MessageList />
          <ChatInterface />
        </div>
        <div
          onMouseDown={onMouseDown}
          style={{
            width: 5, cursor: 'col-resize', background: '#eee',
            flexShrink: 0, transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = '#ccc' }}
          onMouseLeave={(e) => { if (!dragging.current) e.currentTarget.style.background = '#eee' }}
        />
        <div style={{ flex: 1, minWidth: 280 }}>
          <PreviewArea />
        </div>
      </div>
    </div>
  )
}
