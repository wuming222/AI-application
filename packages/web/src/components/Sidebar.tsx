import { useEffect, useState } from 'react'
import { Button, Input, Empty, Dropdown, message as antdMessage } from 'antd'
import { 
  PlusOutlined, 
  MenuFoldOutlined, 
  MenuUnfoldOutlined, 
  MoreOutlined,
  EditOutlined,
  DeleteOutlined,
  MessageOutlined,
  DragOutlined,
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

// Sortable session item component
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

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      onClick={() => switchSession(session.id)}
      className={`session-item ${isDragging ? 'dragging' : ''}`}
    >
      {/* Drag handle */}
      <div
        {...attributes}
        {...listeners}
        className="drag-handle"
      >
        <DragOutlined />
      </div>

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
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <div style={{ 
              overflow: 'hidden', 
              textOverflow: 'ellipsis', 
              whiteSpace: 'nowrap',
              color: isActive ? '#333' : '#666',
              fontWeight: isActive ? 500 : 400,
            }}>
              <MessageOutlined style={{ marginRight: 6, color: '#6b9fd4' }} />
              {session.title}
            </div>
          </div>
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

  // Setup drag sensor
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before drag starts
      },
    })
  )

  useEffect(() => {
    loadSessions().then(() => {
      useChatStore.getState().initFirstSession()
    })
  }, [])

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
    <div style={{ 
      width: 260, 
      borderRight: '1px solid #f0f0f0', 
      display: 'flex', 
      flexDirection: 'column', 
      background: '#fafafa',
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
                {sessions.map((session) => {
                  const isActive = session.id === currentSessionId
                  
                  return (
                    <div
                      key={session.id}
                      style={{
                        padding: '10px 12px',
                        marginBottom: 4,
                        cursor: 'pointer',
                        background: isActive ? '#ffffff' : 'transparent',
                        borderRadius: 8,
                        border: isActive ? '1px solid #e8e8e8' : '1px solid transparent',
                        boxShadow: isActive ? '0 2px 6px rgba(0, 0, 0, 0.04)' : 'none',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        fontSize: 13,
                        transition: 'all 0.2s ease',
                      }}
                    >
                      <SortableSessionItem
                        session={session}
                        isActive={isActive}
                        isEditing={editingId === session.id}
                        editTitle={editTitle}
                        setEditTitle={setEditTitle}
                        submitRename={submitRename}
                        setEditingId={setEditingId}
                        handleRename={handleRename}
                        handleDelete={handleDelete}
                        switchSession={switchSession}
                      />
                    </div>
                  )
                })}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>
    </div>
  )
}
