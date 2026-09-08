import type { ToolDefinition } from '../llm/types'
import { useWorkspaceStore } from '../store/workspaceStore'

const READ_FILE_MAX_CHARS = 8000

export interface ToolExecutor {
  execute(args: Record<string, unknown>): Promise<string> | string
}

interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
}

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor })
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  async execute(name: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.get(name)
    if (!tool) {
      return `错误: 未知工具 ${name}`
    }
    try {
      return await tool.executor.execute(args)
    } catch (err) {
      return `错误: 工具执行失败 - ${(err as Error).message}`
    }
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }
}

export const registry = new ToolRegistry()

// 注册内置 fs 工具
registry.register(
  {
    name: 'write_file',
    description: '写入文件到虚拟文件系统。用于创建或更新源代码文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，如 src/app.tsx' },
        content: { type: 'string', description: '文件内容' },
      },
      required: ['path', 'content'],
    },
  },
  {
    execute: (args) => useWorkspaceStore.getState().writeFile(args.path as string, args.content as string),
  },
)

registry.register(
  {
    name: 'read_file',
    description: '读取虚拟文件系统中的文件内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
      },
      required: ['path'],
    },
  },
  {
    execute: (args) => {
      // 单条工具结果过大可直接触发硬截断，从源头控制大小（设计文档 12.1）
      const content = useWorkspaceStore.getState().readFile(args.path as string)
      if (content.length > READ_FILE_MAX_CHARS) {
        return (
          content.slice(0, READ_FILE_MAX_CHARS) +
          `\n...[已截断，原文件共 ${content.length} 字符]`
        )
      }
      return content
    },
  },
)

registry.register(
  {
    name: 'list_files',
    description: '列出虚拟文件系统中的所有文件。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    execute: () => useWorkspaceStore.getState().listFiles(),
  },
)

registry.register(
  {
    name: 'delete_file',
    description: '删除虚拟文件系统中的文件。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
      },
      required: ['path'],
    },
  },
  {
    execute: (args) => useWorkspaceStore.getState().deleteFile(args.path as string),
  },
)
