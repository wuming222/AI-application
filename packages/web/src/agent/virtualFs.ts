export class VirtualFS {
  private files = new Map<string, string>()

  normalizePath(path: string): string {
    return path.replace(/^\/+/, '').replace(/\/+/g, '/').replace(/\/$/, '')
  }

  writeFile(path: string, content: string): string {
    const normalized = this.normalizePath(path)
    this.files.set(normalized, content)
    return `已写入 ${normalized} (${content.length} 字节)`
  }

  readFile(path: string): string {
    const normalized = this.normalizePath(path)
    const content = this.files.get(normalized)
    if (content === undefined) {
      return `错误: 文件不存在 ${normalized}`
    }
    return content
  }

  listFiles(): string {
    if (this.files.size === 0) {
      return '(空)'
    }
    return Array.from(this.files.keys()).sort().join('\n')
  }

  deleteFile(path: string): string {
    const normalized = this.normalizePath(path)
    if (!this.files.has(normalized)) {
      return `错误: 文件不存在 ${normalized}`
    }
    this.files.delete(normalized)
    return `已删除 ${normalized}`
  }

  getAllFiles(): Map<string, string> {
    return new Map(this.files)
  }

  clear(): void {
    this.files.clear()
  }
}

export const workspace = new VirtualFS()
