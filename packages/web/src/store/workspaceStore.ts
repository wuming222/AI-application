import { create } from 'zustand'

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

interface WorkspaceState {
  filesBySession: Record<string, Record<string, string>>
  currentSessionId: string | null
  filesFor: (sessionId: string) => Record<string, string>
  writeFile: (sessionId: string, path: string, content: string) => string
  readFile: (sessionId: string, path: string) => string
  listFiles: (sessionId: string) => string
  deleteFile: (sessionId: string, path: string) => string
  editFile: (sessionId: string, path: string, oldString: string, newString: string) => string
  setCurrentSession: (sessionId: string) => void
  loadWorkspace: (sessionId: string, files: Record<string, string>) => void
}

/**
 * 所有读写都显式带 sessionId。
 * 后台那一路生成可以在用户切走之后继续写文件，隐式取"当前会话"会把它的产物
 * 落进用户此刻正打开的另一条会话（并且收尾的全量覆盖 PUT 会抹掉那边的代码）。
 */
export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  filesBySession: {},
  currentSessionId: null,

  filesFor: (sessionId) => get().filesBySession[sessionId] ?? {},

  writeFile: (sessionId, path, content) => {
    const normalized = normalizePath(path)
    set((s) => {
      const sessionFiles = { ...(s.filesBySession[sessionId] ?? {}), [normalized]: content }
      return { filesBySession: { ...s.filesBySession, [sessionId]: sessionFiles } }
    })
    return `已写入 ${normalized} (${content.length} 字节)`
  },

  readFile: (sessionId, path) => {
    const normalized = normalizePath(path)
    const content = (get().filesBySession[sessionId] ?? {})[normalized]
    if (content === undefined) {
      return `错误: 文件不存在 ${normalized}`
    }
    return content
  },

  listFiles: (sessionId) => {
    const keys = Object.keys(get().filesBySession[sessionId] ?? {}).sort()
    return keys.length === 0 ? '(空)' : keys.join('\n')
  },

  deleteFile: (sessionId, path) => {
    const normalized = normalizePath(path)
    const files = get().filesBySession[sessionId] ?? {}
    if (!(normalized in files)) {
      return `错误: 文件不存在 ${normalized}`
    }
    set((s) => {
      const sessionFiles = { ...s.filesBySession[sessionId] }
      delete sessionFiles[normalized]
      return { filesBySession: { ...s.filesBySession, [sessionId]: sessionFiles } }
    })
    return `已删除 ${normalized}`
  },

  editFile: (sessionId, path, oldString, newString) => {
    if (!oldString) {
      return '提示: oldString 为空。如需创建或覆盖文件，请使用 write_file。'
    }
    if (oldString === newString) {
      return '错误: oldString 与 newString 相同，无需修改。'
    }
    const normalized = normalizePath(path)
    const files = get().filesBySession[sessionId] ?? {}
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
      const sessionFiles = { ...s.filesBySession[sessionId], [normalized]: updated }
      return { filesBySession: { ...s.filesBySession, [sessionId]: sessionFiles } }
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
