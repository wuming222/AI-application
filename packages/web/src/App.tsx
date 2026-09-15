import { useState, useCallback, useRef, useEffect } from 'react'
import { theme } from 'antd'
import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'
import { PreviewArea } from './components/PreviewArea'
import { Sidebar } from './components/Sidebar'
import { useSessionStore } from './store/sessionStore'
import './App.css'

/**
 * antd v6 在这里没有把 token 暴露成全局 --ant-* 变量（实测组件节点上取不到），
 * 所以把需要的 token 桥成自有 CSS 变量挂在根上，各组件的同名 .css 用 var() 取。
 * 目的：颜色/圆角跟着 ConfigProvider 的主题与系统深色模式走，不在 css 里写死。
 */
function useThemeVars(): React.CSSProperties {
  const { token } = theme.useToken()
  return {
    '--app-text': token.colorText,
    '--app-text-secondary': token.colorTextSecondary,
    '--app-text-tertiary': token.colorTextTertiary,
    '--app-bg-container': token.colorBgContainer,
    '--app-bg-layout': token.colorBgLayout,
    '--app-border': token.colorBorder,
    '--app-border-secondary': token.colorBorderSecondary,
    '--app-split': token.colorSplit,
    '--app-primary': token.colorPrimary,
    '--app-info': token.colorInfo,
    '--app-info-bg': token.colorInfoBg,
    '--app-success': token.colorSuccess,
    '--app-warning': token.colorWarning,
    '--app-error': token.colorError,
    '--app-fill-secondary': token.colorFillSecondary,
    '--app-fill-tertiary': token.colorFillTertiary,
    '--app-fill-quaternary': token.colorFillQuaternary,
    '--app-radius': `${token.borderRadius}px`,
    '--app-radius-lg': `${token.borderRadiusLG}px`,
  } as React.CSSProperties
}

export default function App() {
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const themeVars = useThemeVars()
  const { sessions, currentSessionId } = useSessionStore()

  // 获取当前会话标题
  const currentSession = sessions.find(s => s.id === currentSessionId)
  const headerTitle = currentSession?.title || 'AI App Generator'

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
    <div className="app-shell" style={themeVars}>
      <Sidebar />
      <div ref={containerRef} className="app-main">
        <div className="app-chat" style={{ width: chatWidth ?? undefined, flex: chatWidth === null ? 1 : undefined }}>
          <header className="app-chat-header">{headerTitle}</header>
          <MessageList />
          <ChatInterface />
        </div>
        <div className="chat-splitter" onMouseDown={onMouseDown} />
        <div className="app-preview">
          <PreviewArea />
        </div>
      </div>
    </div>
  )
}
