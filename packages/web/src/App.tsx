import { useState, useCallback, useRef, useEffect } from 'react'
import { theme } from 'antd'
import { ChatInterface } from './components/ChatInterface'
import { MessageList } from './components/MessageList'
import { PreviewArea } from './components/PreviewArea'
import { Sidebar } from './components/Sidebar'
import { useSessionStore } from './store/sessionStore'
import { loadMcpCapabilities } from './agent/providers/mcp'
import { loadSkillCatalog } from './agent/providers/skills'
import './App.css'

/**
 * antd v6 在这里没有把 token 暴露成全局 --ant-* 变量（实测组件节点上取不到），
 * 所以把**主题派生的颜色**桥成 --app-* 挂在根上，各组件的同名 .css 用 var() 取。
 * 静态尺度（间距/圆角/字号/阴影/动效）在 styles/tokens.css，别往这里搬，否则同一值两套来源。
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

  // MCP 清单与界面无关，一挂载就发起（幂等），这样第一次生成不用等它。
  // 它是全局偏好，不是会话状态，所以不进任何 store 分片。
  // 技能目录现在两家来源：内置（零成本）+ 百炼（一次列表 ~0.6s，缓存 10 分钟）。
  // 一个技能都没开着时不预热已经不再成立 —— 用户需要看到有哪些技能可选，
  // 所以改成无条件拉一次。
  useEffect(() => {
    loadMcpCapabilities()
    void loadSkillCatalog()
  }, [])

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
