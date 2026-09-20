import type { ToolDefinition } from '../llm/types'
import type { CapabilityKind, ToolContext, ToolDurability, ToolEffect } from './types'
import { useWorkspaceStore } from '../store/workspaceStore'

const READ_FILE_MAX_CHARS = 8000

export interface ToolResult {
  text: string
  // 能力工具的成败在协议层（MCP 的 JSON-RPC isError / skill 的取正文失败），HTTP 恒 200，
  // 所以要把这个位带到进度渲染层
  isError?: boolean
}

export interface ToolExecutor {
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult | string> | ToolResult | string
}

interface RegisteredTool {
  definition: ToolDefinition
  executor: ToolExecutor
  // 带 sourceId 即能力工具（MCP / skill），受该 source 的开关约束；无 meta 即内置 fs 工具，恒在。
  // durability / effect 是给上下文预算层与调用方读的语义，不参与"发不发给模型"的筛选。
  meta?: {
    provider: CapabilityKind
    sourceId: string
    durability?: ToolDurability
    effect?: ToolEffect
  }
}

class ToolRegistry {
  private tools = new Map<string, RegisteredTool>()

  register(definition: ToolDefinition, executor: ToolExecutor, meta?: RegisteredTool['meta']): void {
    this.tools.set(definition.name, { definition, executor, meta })
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition)
  }

  /**
   * 按启用的 source 过滤**发给模型的 definitions 副本**。
   * 注册表本身仍是进程级、一次性注册 —— 这里只筛不发，绝不 unregister，
   * 否则就等于把"这一轮的筛选结果"写进全局单例，后台并行的另一路会被污染。
   */
  getDefinitionsFor(enabledSourceIds: Set<string>): ToolDefinition[] {
    return Array.from(this.tools.values())
      .filter((t) => !t.meta || enabledSourceIds.has(t.meta.sourceId))
      .map((t) => t.definition)
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    return (await this.executeDetailed(name, args, ctx)).text
  }

  async executeDetailed(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { text: `错误: 未知工具 ${name}`, isError: true }
    }
    try {
      const result = await tool.executor.execute(args, ctx)
      return typeof result === 'string' ? { text: result } : result
    } catch (err) {
      return { text: `错误: 工具执行失败 - ${(err as Error).message}`, isError: true }
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
    execute: (args, ctx) =>
      useWorkspaceStore.getState().writeFile(ctx.sessionId, args.path as string, args.content as string),
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
    execute: (args, ctx) => {
      // 单条工具结果过大可直接触发硬截断，从源头控制大小（设计文档 12.1）
      const content = useWorkspaceStore.getState().readFile(ctx.sessionId, args.path as string)
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
    execute: (_args, ctx) => useWorkspaceStore.getState().listFiles(ctx.sessionId),
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
    execute: (args, ctx) => useWorkspaceStore.getState().deleteFile(ctx.sessionId, args.path as string),
  },
)

registry.register(
  {
    name: 'edit_file',
    description:
      '对文件执行局部文本替换。提供要被替换的旧文本(oldString)和替换后的新文本(newString)，oldString 必须在文件中唯一出现。修改前先 read_file 确认当前内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        oldString: { type: 'string', description: '要被替换的旧文本，必须在文件中唯一出现' },
        newString: { type: 'string', description: '替换后的新文本' },
      },
      required: ['path', 'oldString', 'newString'],
    },
  },
  {
    execute: (args, ctx) =>
      useWorkspaceStore
        .getState()
        .editFile(ctx.sessionId, args.path as string, args.oldString as string, args.newString as string),
  },
)
