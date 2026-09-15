import { useEffect, useState } from 'react'
import { Button, Input, Empty, Dropdown, message as antdMessage } from 'antd'
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

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    // 保留 dnd-kit 的 transform 过渡，同时保留选中态的背景/边框变化过渡
    transition: [transition, 'background 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease']
      .filter(Boolean)
      .join(', '),
    opacity: isDragging ? 0.5 : 1,
    padding: '10px 12px',
    marginBottom: 4,
    cursor: 'pointer',
    background: isActive ? '#ffffff' : 'transparent',
    borderRadius: 8,
    border: isActive ? '1px solid #e8e8e8' : '1px solid transparent',
    boxShadow: isActive ? '0 2px 6px rgba(0, 0, 0, 0.04)' : 'none',
    fontSize: 13,
    color: isActive ? '#333' : '#666',
    fontWeight: isActive ? 500 : 400,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`session-item ${isDragging ? 'dragging' : ''}`}
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
              icon={<MoreOutlined />}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => e.stopPropagation()}
              style={{ opacity: isActive ? 1 : 0 }}
            />
          </Dropdown>
        </>
      )}
    </div>
  )
}

export function Sidebar() {
  const { sessions, currentSessionId, isLoading, loadSessions, createSession, switchSession, deleteSession, renameSession, reorderSessions } = useSessionStore()
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
      <div style={{ 
        width: 48, 
        borderRight: '1px solid #f0f0f0', 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        paddingTop: 12,
        background: '#fafafa',
      }}>
        <Button
          type="text"
          icon={<MenuUnfoldOutlined />}
          onClick={() => setCollapsed(false)}
          style={{ marginBottom: 8 }}
        />
        <Button
          type="text"
          icon={<PlusOutlined />}
          onClick={() => createSession()}
        />
      </div>
    )
  }

  return (
    <>
      <div style={{ 
        width: sidebarWidth, 
        borderRight: '1px solid #f0f0f0', 
        display: 'flex', 
        flexDirection: 'column', 
        background: '#fafafa',
        position: 'relative',
      }}>
        {/* Header */}
        <div style={{ 
          padding: '16px', 
          borderBottom: '1px solid #f0f0f0', 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center',
        }}>
          <span style={{ fontWeight: 600, fontSize: 15, color: '#333' }}>会话列表</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <Button
              type="text"
              size="small"
              icon={<PlusOutlined />}
              onClick={() => createSession()}
              title="新建会话"
            />
            <Button
              type="text"
              size="small"
              icon={<MenuFoldOutlined />}
              onClick={() => setCollapsed(true)}
              title="收起侧边栏"
            />
          </div>
        </div>

        {/* Session List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
          {isLoading ? (
            <div style={{ padding: 16, color: '#999', fontSize: 13, textAlign: 'center' }}>加载中...</div>
          ) : sessions.length === 0 ? (
            <div style={{ padding: '40px 16px' }}>
              <Empty description="暂无会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            </div>
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
              <SortableContext items={sessions.map((s) => s.id)}>
                <div style={{ padding: '0 8px' }}>
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
          style={{
            position: 'absolute',
            right: 0,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: 'col-resize',
            zIndex: 10,
          }}
        />
      </div>
    </>
  )
}
