import { create } from 'zustand'

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

interface WorkspaceState {
  filesBySession: Record<string, Record<string, string>>
  currentSessionId: string | null
  writeFile: (path: string, content: string) => string
  readFile: (path: string) => string
  listFiles: () => string[]
  deleteFile: (path: string) => string
  setCurrentSession: (sessionId: string) => void
  loadWorkspace: (sessionId: string, files: Record<string, string>) => void
  getCurrentFiles: () => Record<string, string>
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  filesBySession: {},
  currentSessionId: null,

  getCurrentFiles: () => {
    const sid = get().currentSessionId
    if (!sid) return {}
    return get().filesBySession[sid] ?? {}
  },

  writeFile: (path, content) => {
    const normalized = normalizePath(path)
    const sid = get().currentSessionId
    if (!sid) return '错误: 无活跃会话'
    set((s) => {
      const sessionFiles = { ...(s.filesBySession[sid] ?? {}), [normalized]: content }
      return { filesBySession: { ...s.filesBySession, [sid]: sessionFiles } }
    })
    return `已写入 ${normalized} (${content.length} 字节)`
  },

  readFile: (path) => {
    const normalized = normalizePath(path)
    const files = get().getCurrentFiles()
    const content = files[normalized]
    if (content === undefined) {
      return `错误: 文件不存在 ${normalized}`
    }
    return content
  },

  listFiles: () => {
    const keys = Object.keys(get().getCurrentFiles()).sort()
    return keys.length === 0 ? '(空)' : keys.join('\n')
  },

  deleteFile: (path) => {
    const normalized = normalizePath(path)
    const sid = get().currentSessionId
    if (!sid) return '错误: 无活跃会话'
    const files = get().filesBySession[sid] ?? {}
    if (!(normalized in files)) {
      return `错误: 文件不存在 ${normalized}`
    }
    set((s) => {
      const sessionFiles = { ...s.filesBySession[sid] }
      delete sessionFiles[normalized]
      return { filesBySession: { ...s.filesBySession, [sid]: sessionFiles } }
    })
    return `已删除 ${normalized}`
  },

  setCurrentSession: (sessionId) => {
    set({ currentSessionId: sessionId })
  },

  loadWorkspace: (sessionId, files) => {
    set((s) => ({
      filesBySession: { ...s.filesBySession, [sessionId]: files },
    }))
  },
}))
