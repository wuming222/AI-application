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
} from '@ant-design/icons'
import { useSessionStore } from '../store/sessionStore'
import { useChatStore } from '../store/chatStore'

export function Sidebar() {
  const { sessions, currentSessionId, isLoading, loadSessions, createSession, switchSession, deleteSession, renameSession } = useSessionStore()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')
  const [collapsed, setCollapsed] = useState(false)

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
          <div style={{ padding: '0 8px' }}>
            {sessions.map((session) => {
              const isActive = session.id === currentSessionId
              
              return (
                <div
                  key={session.id}
                  onClick={() => switchSession(session.id)}
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
                  {editingId === session.id ? (
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
            })}
          </div>
        )}
      </div>
    </div>
  )
}
