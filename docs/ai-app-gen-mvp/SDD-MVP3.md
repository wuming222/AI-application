# 慧应用 MVP-3：工具调用 + Responses API - SDD

## 需求

在 MVP-2 Agent Loop 骨架基础上接入真实工具调用能力，并将 LLM 调用切换到 DashScope Responses API（原生支持 web_search 内置工具）。

MVP-3 **只做**：Message 类型扩展（tool_calls / tool_result）、虚拟文件系统、工具注册表、Responses API provider、Agent Loop 改为 toolCalls 驱动循环。**不做**：iframe 预览、MCP 工具、BaaS 工具、上下文截断。

## 实现步骤

### 阶段 0：扩展 Message 类型

`llm/types.ts` 新增：
- `ToolCall { id, type: 'function', function: { name, arguments } }`
- `ToolDefinition { name, description, parameters }`
- `Message.role` 增加 `'tool'`，新增 `tool_calls?` 和 `tool_call_id?` 字段
- `StreamChunk` 新增 `tool_calls?` 字段

### 阶段 1：虚拟文件系统

`agent/virtualFs.ts`：
- `VirtualFS` 类，内存 Map 存储文件
- `writeFile(path, content)` / `readFile(path)` / `listFiles()` / `deleteFile(path)`
- 路径规范化（去前导斜杠、合并重复斜杠）
- 导出单例 `workspace`

### 阶段 2：工具注册表

`agent/toolRegistry.ts`：
- `ToolRegistry` 类：`register(def, executor)` / `getDefinitions()` / `execute(name, args)`
- 内置四个 fs 工具：`write_file` / `read_file` / `list_files` / `delete_file`
- 导出单例 `registry`

### 阶段 3：LLM Provider 改造

- `router.ts`：`StreamChatOptions { tools?: ToolDefinition[] }`，provider 改为 `mock | responses`
- `providers/responses.ts`（新）：
  - 请求体：`{ model, input: messages, stream: true, tools: [{ type: 'web_search' }, ...functionTools] }`
  - SSE 解析：按 `\n\n` 分帧 → 找 `data:` 行（注意无空格）→ JSON.parse
  - 事件映射：`response.output_text.delta` → StreamChunk delta；`response.output_item.added` (function_call) → 记录 pendingFunctionCalls；`response.function_call_arguments.delta` → 累加参数；`response.completed` → yield done + tool_calls
  - 过滤 `response.reasoning_text.delta`（思考过程不作为用户可见内容）
- 删除 `providers/openai.ts`（不再使用 Chat Completions API）
- Server proxy `llm.py`：提取 `_proxy_to_upstream()` 公共函数，新增 `/responses` 端点，修复流式转发 `chunk_size=1024`

### 阶段 4：Agent Loop 改造

`agent/runAgentLoop.ts`：
- 移除固定轮数限制，改为 `maxRounds=20` 上限 + toolCalls 为空时自主终止
- 每轮调 `streamChat(allMessages, signal, { tools: registry.getDefinitions() })`
- 收集 `tool_calls`，为空则 push assistant message 并 break
- 非空则执行每个 tool call → push `role: 'tool'` 消息 → 继续下一轮

### 阶段 5：AgentProgress UI 更新

`agent/types.ts`：`AgentProgressStep` 增加 `toolCalls?: AgentToolCallInfo[]`，status 增加 `'tool-call'`
`AgentProgress.tsx`：显示工具执行状态（名称、路径、完成/运行中）

## 验收标准

- [ ] 发送"你好"，模型正常回复（无 reasoning 泄露）
- [ ] 发送"今天北京天气怎么样"，触发 web_search，回复包含实时信息
- [ ] 发送"创建一个 index.html"，触发 write_file 工具调用，虚拟文件系统写入成功
- [ ] Agent Loop 在 toolCalls 为空时自主终止，不无限循环
- [ ] 中止按钮正常工作
- [ ] 类型检查通过

## 关键技术决策

### 为什么用 Responses API 而非 Chat Completions

| 维度 | Chat Completions | Responses API |
|------|-----------------|---------------|
| web_search | 需 `enable_search` 参数，不支持返回来源 | 原生 `{ type: "web_search" }` tool |
| 上下文管理 | 手动拼接 messages | `previous_response_id` 自动管理 |
| 流式事件 | `choices[0].delta` | 结构化事件（output_text.delta / function_call） |
| 未来扩展 | 仅 function calling | 支持 code_interpreter / web_extractor 等内置工具 |

### reasoning 文本处理

qwen3.7-flash 是思考模型，每次响应先输出 `response.reasoning_text.delta`（思考过程），再输出 `response.output_text.delta`（最终回复）。当前选择**过滤 reasoning**，只向用户展示 output_text。后续可增加"展开思考过程"UI 开关。

### Server Proxy 流式修复

Responses API 的 SSE 帧比 Chat Completions 更小更频繁。httpx `aiter_bytes()` 默认 chunk size 导致只转发第一个事件就停滞，改为 `chunk_size=1024` 解决。
