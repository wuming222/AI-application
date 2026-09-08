import { create } from 'zustand'

function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
}

interface WorkspaceState {
  files: Record<string, string>
  writeFile: (path: string, content: string) => string
  readFile: (path: string) => string
  listFiles: () => string[]
  deleteFile: (path: string) => string
  clear: () => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  files: {},

  writeFile: (path, content) => {
    const normalized = normalizePath(path)
    set((s) => ({ files: { ...s.files, [normalized]: content } }))
    return `已写入 ${normalized} (${content.length} 字节)`
  },

  readFile: (path) => {
    const normalized = normalizePath(path)
    const content = get().files[normalized]
    if (content === undefined) {
      return `错误: 文件不存在 ${normalized}`
    }
    return content
  },

  listFiles: () => {
    const keys = Object.keys(get().files).sort()
    return keys.length === 0 ? '(空)' : keys.join('\n')
  },

  deleteFile: (path) => {
    const normalized = normalizePath(path)
    if (!(normalized in get().files)) {
      return `错误: 文件不存在 ${normalized}`
    }
    set((s) => {
      const files = { ...s.files }
      delete files[normalized]
      return { files }
    })
    return `已删除 ${normalized}`
  },

  clear: () => set({ files: {} }),
}))
