import { useEffect, useState } from 'react'
import { Button, Input, Empty, Dropdown, Tooltip, message as antdMessage } from 'antd'
import { 
  PlusOutlined, 
  MenuFoldOutlined, 
  MenuUnfoldOutlined, 
  MoreOutlined,
  EditOutlined,
  DeleteOutlined,
} from '@ant-design/icons'
import { DndContext, closestCenter, useSensor, useSensors, PointerSensor } from '@dnd-kit/core'
import type { DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import './Sidebar.css'
import { useSessionStore } from '../store/sessionStore'
import { useChatStore } from '../store/chatStore'
import type { Session } from '../api/sessions'

interface SortableSessionItemProps {
  session: Session
  isActive: boolean
  isEditing: boolean
  editTitle: string
  setEditTitle: (title: string) => void
  submitRename: () => void
  setEditingId: (id: string | null) => void
  handleRename: (id: string, title: string) => void
  handleDelete: (id: string) => void
  switchSession: (id: string) => void
}

// 整条会话项即可拖动：卡片样式与 dnd-kit 的 ref/transform/listeners 必须落在同一个节点上，
// 否则只有内层在位移，卡片视觉与位置会错位
function SortableSessionItem({ 
  session, 
  isActive, 
  isEditing, 
  editTitle, 
  setEditTitle, 
  submitRename, 
  setEditingId, 
  handleRename, 
  handleDelete,
  switchSession,
}: SortableSessionItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: session.id,
  })

  // 只放必须动态计算的两项；卡片与状态样式交给 .session-item / .active / .dragging，
  // 否则 inline style 会覆盖 CSS 里的状态规则（实测曾让拖拽高亮失效）
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: [transition, 'background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease, opacity 0.2s ease']
      .filter(Boolean)
      .join(', '),
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-item ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''}`}
      onClick={() => switchSession(session.id)}
      {...attributes}
      {...(isEditing ? {} : listeners)}
    >
      {isEditing ? (
        <Input
          autoFocus
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={submitRename}
          onKeyDown={(e) => { 
            if (e.key === 'Enter') submitRename()
            if (e.key === 'Escape') setEditingId(null) 
          }}
          onClick={(e) => e.stopPropagation()}
          size="small"
          style={{ flex: 1 }}
        />
      ) : (
        <>
          <div className="session-item-title">{session.title}</div>
          <Dropdown
            menu={{
              items: [
                {
                  key: 'rename',
                  label: '重命名',
                  icon: <EditOutlined />,
                  onClick: ({ domEvent }) => {
                    domEvent.stopPropagation()
                    handleRename(session.id, session.title)
                  },
                },
                {
                  key: 'delete',
                  label: '删除',
                  icon: <DeleteOutlined />,
                  danger: true,
                  onClick: ({ domEvent }) => {
                    domEvent.stopPropagation()
                    handleDelete(session.id)
                  },
                },
              ],
            }}
            trigger={['click']}
          >
            <Button
              type="text"
              size="small"
              className="session-more"
              icon={<MoreOutlined />}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
            />
          </Dropdown>
        </>
      )}
    </div>
  )
}

export function Sidebar() {
  const { sessions, currentSessionId, isLoading, loadSessions, createOrReuseSession, switchSession, deleteSession, renameSession, reorderSessions } = useSessionStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [collapsed, setCollapsed] = useState(false)
  
  // Sidebar resize state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? parseInt(saved, 10) : 260
  })
  const [isResizing, setIsResizing] = useState(false)

  // Setup drag sensor
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        // 长按 250ms 才进入拖拽；期间移动超过 5px 视为点击/滚动，取消激活
        delay: 250,
        tolerance: 5,
      },
    })
  )

  useEffect(() => {
    loadSessions().then(() => {
      useChatStore.getState().initFirstSession()
    })
  }, [])

  // Resize handlers
  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  useEffect(() => {
    const handleResizeMove = (e: MouseEvent) => {
      if (!isResizing) return
      
      const newWidth = e.clientX
      // Clamp between 200px and 500px
      const clampedWidth = Math.min(Math.max(newWidth, 200), 500)
      setSidebarWidth(clampedWidth)
    }

    const handleResizeEnd = () => {
      if (isResizing) {
        setIsResizing(false)
        localStorage.setItem('sidebar-width', String(sidebarWidth))
      }
    }

    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove)
      document.addEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
    }

    return () => {
      document.removeEventListener('mousemove', handleResizeMove)
      document.removeEventListener('mouseup', handleResizeEnd)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing, sidebarWidth])

  const handleRename = (id: string, currentTitle: string) => {
    setEditingId(id)
    setEditTitle(currentTitle)
  }

  const submitRename = () => {
    if (editingId && editTitle.trim()) {
      renameSession(editingId, editTitle.trim())
      antdMessage.success('重命名成功')
    }
    setEditingId(null)
  }

  const handleDelete = (id: string) => {
    deleteSession(id)
    antdMessage.success('已删除')
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (!over || active.id === over.id) return

    const oldIndex = sessions.findIndex((s) => s.id === active.id)
    const newIndex = sessions.findIndex((s) => s.id === over.id)

    // Defensive check: ensure both indices are valid
    if (oldIndex === -1 || newIndex === -1) return

    reorderSessions(oldIndex, newIndex)
  }

  // 折叠状态
  if (collapsed) {
    return (
      <div className="sidebar-collapsed">
        <Tooltip title="展开侧边栏">
          <Button
            type="text"
            className="sidebar-expand"
            icon={<MenuUnfoldOutlined />}
            onClick={() => setCollapsed(false)}
          />
        </Tooltip>
        <Tooltip title="新建会话">
          <Button
            type="text"
            icon={<PlusOutlined />}
            onClick={() => createOrReuseSession()}
          />
        </Tooltip>
      </div>
    )
  }

  return (
    <>
      <div className="sidebar" style={{ width: sidebarWidth }}>
        {/* Header */}
        <div className="sidebar-header">
          <span className="sidebar-title">会话列表</span>
          <div className="sidebar-actions">
            <Tooltip title="新建会话">
              <Button
                type="text"
                size="small"
                icon={<PlusOutlined />}
                onClick={() => createOrReuseSession()}
              />
            </Tooltip>
            <Tooltip title="收起侧边栏">
              <Button
                type="text"
                size="small"
                icon={<MenuFoldOutlined />}
                onClick={() => setCollapsed(true)}
              />
            </Tooltip>
          </div>
        </div>

        {/* Session List */}
        <div className="session-list">
          {isLoading ? (
            <div className="session-loading">加载中...</div>
          ) : sessions.length === 0 ? (
            <div className="session-empty">
              <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sessions.map((s) => s.id)}>
                <div className="session-list-inner">
                  {sessions.map((session) => (
                    <SortableSessionItem
                      key={session.id}
                      session={session}
                      isActive={session.id === currentSessionId}
                      isEditing={editingId === session.id}
                      editTitle={editTitle}
                      setEditTitle={setEditTitle}
                      submitRename={submitRename}
                      setEditingId={setEditingId}
                      handleRename={handleRename}
                      handleDelete={handleDelete}
                      switchSession={switchSession}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>

        {/* Resize handle */}
        <div
          className={`resize-handle ${isResizing ? 'resizing' : ''}`}
          onMouseDown={handleResizeStart}
        />
      </div>
    </>
  )
}
