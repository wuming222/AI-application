import { useEffect, useState } from 'react'
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
    }
    setEditingId(null)
  }

  if (collapsed) {
    return (
      <div style={{ width: 40, borderRight: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 8 }}>
        <button onClick={() => setCollapsed(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }} title="展开侧边栏">☰</button>
        <button onClick={() => createSession()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, marginTop: 8 }} title="新建会话">+</button>
      </div>
    )
  }

  return (
    <div style={{ width: 240, borderRight: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', background: '#fafafa' }}>
      <div style={{ padding: '12px', borderBottom: '1px solid #e0e0e0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>会话列表</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={() => createSession()} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, lineHeight: 1 }} title="新建会话">+</button>
          <button onClick={() => setCollapsed(true)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14 }} title="收起侧边栏">◀</button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {isLoading ? (
          <div style={{ padding: 16, color: '#999', fontSize: 13 }}>加载中...</div>
        ) : sessions.length === 0 ? (
          <div style={{ padding: 16, color: '#999', fontSize: 13 }}>暂无会话</div>
        ) : (
          sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => switchSession(session.id)}
              style={{
                padding: '10px 12px',
                cursor: 'pointer',
                background: session.id === currentSessionId ? '#e8f0fe' : 'transparent',
                borderLeft: session.id === currentSessionId ? '3px solid #1a73e8' : '3px solid transparent',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 13,
              }}
            >
              {editingId === session.id ? (
                <input
                  autoFocus
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={submitRename}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') setEditingId(null) }}
                  onClick={(e) => e.stopPropagation()}
                  style={{ flex: 1, padding: '2px 4px', fontSize: 13, border: '1px solid #ccc', borderRadius: 2 }}
                />
              ) : (
                <>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{session.title}</span>
                  <div style={{ display: 'flex', gap: 4, opacity: 0.5, fontSize: 12 }} onClick={(e) => e.stopPropagation()}>
                    <span style={{ cursor: 'pointer' }} onClick={() => handleRename(session.id, session.title)} title="重命名">✎</span>
                    <span style={{ cursor: 'pointer' }} onClick={() => deleteSession(session.id)} title="删除">✕</span>
                  </div>
                </>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
