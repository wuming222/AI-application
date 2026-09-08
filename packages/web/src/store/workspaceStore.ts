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
  editFile: (path: string, oldString: string, newString: string) => string
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

  editFile: (path, oldString, newString) => {
    if (!oldString) {
      return '提示: oldString 为空。如需创建或覆盖文件，请使用 write_file。'
    }
    if (oldString === newString) {
      return '错误: oldString 与 newString 相同，无需修改。'
    }
    const normalized = normalizePath(path)
    const sid = get().currentSessionId
    if (!sid) return '错误: 无活跃会话'
    const files = get().filesBySession[sid] ?? {}
    if (!(normalized in files)) {
      return `错误: 文件不存在 ${normalized}`
    }
    const content = files[normalized]
    let count = 0
    let pos = 0
    while ((pos = content.indexOf(oldString, pos)) !== -1) {
      count++
      pos += oldString.length
    }
    if (count === 0) {
      return `错误: 未找到匹配内容。请用 read_file 重新读取 ${normalized} 确认当前内容后再尝试。`
    }
    if (count > 1) {
      return `错误: 找到 ${count} 处匹配，请提供更多上下文使 oldString 唯一。`
    }
    const updated = content.replace(oldString, newString)
    set((s) => {
      const sessionFiles = { ...s.filesBySession[sid], [normalized]: updated }
      return { filesBySession: { ...s.filesBySession, [sid]: sessionFiles } }
    })
    return `已编辑 ${normalized}（替换 1 处）`
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
