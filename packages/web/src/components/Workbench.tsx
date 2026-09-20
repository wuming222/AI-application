import { useState, useCallback, useRef, useEffect } from 'react'
import { Button, Tooltip } from 'antd'
import { LogoutOutlined } from '@ant-design/icons'
import { ChatInterface } from './ChatInterface'
import { MessageList } from './MessageList'
import { PreviewArea } from './PreviewArea'
import { Sidebar } from './Sidebar'
import { useSessionStore } from '../store/sessionStore'
import { useAuthStore } from '../store/authStore'
import { logout as apiLogout } from '../api/auth'
import { loadMcpCapabilities } from '../agent/providers/mcp'
import { loadSkillCatalog } from '../agent/providers/skills'

/**
 * 登录后才挂载的那一半界面。
 *
 * 之所以要从 App.tsx 拆出来：MCP 清单与技能目录现在都要登录（后端 /api/* 全收口），
 * 放在 App 的挂载副作用里会在未登录时全部 401 —— 而 authFetch 一见 401 就清登录态，
 * 于是刚打开页面就被自己登出一次。拆到"登录后才存在"的组件里，天然没有这个竞态。
 */
export function Workbench() {
  const [chatWidth, setChatWidth] = useState<number | null>(null)
  const dragging = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const { sessions, currentSessionId } = useSessionStore()
  const username = useAuthStore((s) => s.username)

  const currentSession = sessions.find((s) => s.id === currentSessionId)
  const headerTitle = currentSession?.title || 'AI App Generator'

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

  const signOut = async () => {
    await apiLogout()
    useAuthStore.getState().signOut()
  }

  return (
    <>
      <Sidebar />
      <div ref={containerRef} className="app-main">
        <div className="app-chat" style={{ width: chatWidth ?? undefined, flex: chatWidth === null ? 1 : undefined }}>
          <header className="app-chat-header">
            <span className="app-chat-title">{headerTitle}</span>
            <span className="app-chat-account">
              <span className="app-chat-user">{username ?? '未登录'}</span>
              <Tooltip title="退出登录会清空本地已加载的会话数据，服务端记录不受影响">
                <Button size="small" icon={<LogoutOutlined />} className="app-chat-signout" onClick={signOut}>
                  退出登录
                </Button>
              </Tooltip>
            </span>
          </header>
          <MessageList />
          <ChatInterface />
        </div>
        <div className="chat-splitter" onMouseDown={onMouseDown} />
        <div className="app-preview">
          <PreviewArea />
        </div>
      </div>
    </>
  )
}
