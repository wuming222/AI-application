# MCP 外部工具接入 - SDD

需求原文：`docs/origin/26-9-17.md`（四轮确认 + 三次真机冒烟都记在那份文档里，本 SDD 不重复论证，只落实现）
分支：`feature/mcp-external-tools`（base `main` @ `89e3a8e`）

## 需求

把外部 MCP 工具变成模型可调、进度可见、可关的**普通工具**：走已确认的**路线 B（自建式）**，
MCP 客户端落在 FastAPI 侧（浏览器无法起子进程、也不能持有 key），工具定义经 `/api/mcp/tools`
回到前端注册进 `registry`，调用经 `/api/mcp/call` 打回服务端。主循环、进度合并、会话分片、
落库时机**全部不改**——这是本项目接这个能力比一般代码库便宜的原因（`ToolExecutor.execute`
本来就允许返回 `Promise`）。

v1 接入对象写死两个百炼托管 server，配置在服务端代码里，**不做用户添加界面**：

| server | 传输 | 工具数 / schema 字符 | 默认 |
|---|---|---|---|
| `amap-maps` | Streamable HTTP（`/mcp`，实测不回 `mcp-session-id`） | 15 / 5,498 | 启用 |
| `antv-visualization-chart` | SSE（`/sse`，实测对 `/mcp` 返回 405） | 25 / 53,768 | 关闭 |

两条传输形态相反，所以抽象层必须两种都能跑 —— 这也是天然的压力测试对。

范围边界（明确不做）：MCP 的 resources / prompts / sampling / elicitation / OAuth；用户自行添加
server；按本轮意图动态筛工具（第四轮降级，理由见需求文档）；写入类外部工具；`llm.py` 的代理
`trust_env` 问题（独立于本分支，见需求文档"顺带抓到的环境问题"）。

## 设计决策与不变量

1. **只读**：外部工具执行器**不读也不写** `workspaceStore`，结果只作为 `role:'tool'` 文本进上下文。
   `ToolContext.sessionId` 不透传给服务端 —— 外部 server 拿不到我们的会话标识。
2. **`registry` 仍是进程级一次性注册**，只有 `register`，绝不 per-request `unregister`。
   开关只作用于**发给模型的 definitions 副本**（`getDefinitionsFor`），执行侧再加一道守卫。
3. **开关是全局偏好不是会话状态**：localStorage 单 key `mcp-servers-enabled`（`{ [serverId]: boolean }`，
   读时与服务端 `default_enabled` 合并，包 try/catch），不进 `bySession`、不落库。因此生成中途
   翻开关不影响在飞的那一轮（definitions 在每次 `runAgentLoop` 开始处只读一次），下一轮才生效。
4. **成功只看 JSON-RPC 的 `isError`**，HTTP 恒 200。上游错误文本（如
   `API 调用失败：USER_DAILY_QUERY_OVER_LIMIT`）原样回给模型，不自己造句。
5. **结果截断 8,000 字符在服务端做**（`（结果已截断，原内容 N 字符）`），前端拿到的 payload 已有界。
6. **30s 硬超时**，超时/连接失败一律转成 `isError:true` 的可恢复文本，不重试，主循环继续下一轮。

## 实现步骤

### 0. 实现前的一次性验证（不消耗模型 token）

`pip install mcp` 后确认 SDK 客户端两个入口都能接受"不自建 httpx 信任环境"的注入口：
`streamablehttp_client(url, headers, httpx_client_factory=...)` 与 `sse_client(url, headers, httpx_client_factory=...)`。
必须能注，因为本机系统代理 `127.0.0.1:7890` 在 MITM TLS，默认 `trust_env=True` 直接
`UNEXPECTED_EOF_WHILE_READING`（已实测）。
**若某个入口不支持 factory**：该传输退回用 `node_modules/.scratch/mcp_sse_probe.py` 里已跑通的手搓
JSON-RPC + SSE 帧解析（约 60 行），在 `app/mcp/client.py` 里保持同一函数签名，两种实现择一即可。

### 1. 服务端配置：`packages/server/app/mcp/servers.py`

```python
@dataclass(frozen=True)
class MCPServerConfig:
    id: str                  # "amap-maps"
    label: str               # UI 上显示的名字
    transport: str           # "streamable_http" | "sse"
    default_enabled: bool
    tool_prefix: str         # "mcp__amap-maps__"

MCP_SERVERS: list[MCPServerConfig] = [...]

def base_url(cfg) -> str:    # https://dashscope.aliyuncs.com/api/v1/mcps/{id}
def auth_headers() -> dict:  # Bearer LLM_API_KEY —— 只在服务端，绝不出现在响应里
```

`/mcp` 与 `/sse` 两个后缀由 `transport` 决定。key 复用 `app.config.LLM_API_KEY`（同一把 DashScope key，已实测可鉴权）。

### 2. 服务端客户端：`packages/server/app/mcp/client.py`

**每次调用开一条会话、`async with` 走完就关**，不做长连接池：

```python
async def list_tools(cfg, timeout=20.0) -> list[dict]        # [{name, description, inputSchema}]
async def call_tool(cfg, tool, args, timeout=30.0) -> dict   # {text, is_error}
```

理由（这是对之前"按 server 配置做共享池"的**改动**，需要他确认）：
池要处理握手复用、进程/连接崩溃重启，而 SDK 的 `ClientSession` 带 anyio cancel scope，
`AsyncExitStack` 跨请求任务复用会撞上"在另一个 task 里退出 cancel scope"这一类已知失败；
per-call 让 enter/exit 落在同一个协程里，结构上就没这个坑，也不引入任何与"会话分片"纪律相对抗的
全局可变连接状态。代价是每次调用多一遍 `initialize`（约 2 个 RTT、几百毫秒），而一次生成就调几个
工具，量级上无所谓。`tools/list` 另有 TTL 缓存兜住延迟（步骤 3）。

`call_tool` 内部：把 content 块拼成文本（`type=='text'` 取 `text`，非文本块记一句
`[非文本内容: image]` 占位而不是丢弃，模型需要知道有东西没拿到），带 `structuredContent` 时
优先 JSON 序列化 `content`（实测 amap 的 JSON 就装在 `content[].text` 里，原样回传即可）。
`isError` 直接透传。截断也在这里。

### 3. 服务端路由：`packages/server/app/routes/mcp.py`

- `GET /api/mcp/tools` → `{ servers: [{id,label,default_enabled}], tools: [{ name, service, description, parameters }] }`
  - `name` 已加命名空间：`mcp__<service>__<tool>`（防与 5 个 fs 工具撞名，也让模型一眼看出这是外部能力）。
  - 进程内 TTL 缓存 10 分钟；**逐个 server 容错**：某个 server 握手失败时它贡献 0 个工具并在响应里
    带 `errors: [{service, message}]`，绝不让整个端点 500（否则 AntV 配额耗尽会连带 amap 一起不可用）。
- `POST /api/mcp/call` body `{ service, tool, arguments }` → `{ text, is_error }`，**恒 200**（错误在 body 里，
  前端不需要区分 HTTP 异常与工具异常）。
- `main.py` 里 `app.include_router(mcp_router)`。CORS 白名单不动（5173 已在内）。
- `pyproject.toml` 加 `mcp>=1.9`。

### 4. 前端：`agent/toolRegistry.ts` 两处扩展

```ts
export interface ToolResult { text: string; isError?: boolean }
export interface ToolExecutor {
  execute(args, ctx): Promise<ToolResult | string> | ToolResult | string
}
register(definition, executor, meta?: { mcpService?: string }): void
getDefinitionsFor(enabledMcpServices: Set<string>): ToolDefinition[]   // fs 工具恒在；mcp 工具按 service 过滤
async executeDetailed(name, args, ctx): Promise<ToolResult>            // execute() 改成委托它，返回 .text
```

`getDefinitions()` 保留给既有调用方与测试。`tools` Map 的 value 多一个 `meta` 字段，不动 `has`/`register`
的对外语义（无 meta 即内置工具）。

### 5. 前端：`agent/externalTools.ts`（新）

```ts
export function loadExternalTools(): Promise<void>   // 幂等：module-level readyPromise，失败也 resolve（记 console.warn）
export function externalToolsReady(): Promise<void>
export function getEnabledServiceIds(): Set<string>  // localStorage 覆盖 default_enabled
export function setServerEnabled(id: string, on: boolean): void
export function getServers(): McpServerInfo[]        // UI 用；load 成功后填充
export const MCP_ENABLEMENT_KEY = 'mcp-servers-enabled'
```

- fetch 基址同 `responses.ts:92`：`import.meta.env.VITE_API_BASE_URL || ''`。**dev proxy 模式下
  `/api/mcp` 不在 `vite.config.ts` 白名单里**，所以要么给 proxy 加一条，要么（当前使用的模式）
  `VITE_API_BASE_URL` 指向 8000 就自然通。v1 只保证后者，前者作为已知限制记录。
- 每个工具 `registry.register(def, executor, { mcpService: service })`，executor：
  1. `if (!isServerEnabled(service)) return { text: '外部工具未启用：该 MCP 服务当前在输入框的工具开关里被关闭。', isError: true }`
     —— 挡的是模型凭上一轮上下文幻觉调用。
  2. `POST /api/mcp/call`，`AbortSignal.timeout(35_000)`（比服务端 30s 宽一档，让服务端先给出更可读的超时文案）。
  3. 网络层异常 → `{ text: '外部工具调用失败：<msg>', isError: true }`，**不抛**。
- 后端不可用时 `/api/mcp/tools` 拿不到东西 → 一个外部工具都不注册，行为与今天完全一致（退化为无 MCP 的 app）。

### 6. 前端：`agent/runAgentLoop.ts` 三处小改

```ts
// :48 前，循环开始处一次（不在 20 个 round 之间重算）
await Promise.race([externalToolsReady(), delay(2000)])
const toolDefs = registry.getDefinitionsFor(getEnabledServiceIds())

// :140-153 工具执行
const res = await registry.executeDetailed(tc.function.name, args, toolCtx)
allMessages.push({ role: 'tool', tool_call_id: tc.id, content: res.text })
if (row) { row.status = res.isError ? 'error' : 'done'; row.result = res.text }
```

`toolProgress.ts` 的 `RANK` 已把 `error` 与 `done` 同阶（`toolProgress.ts:17`），只前进不后退的规则不用动。

### 7. 前端：`components/AgentProgress.tsx` 补 error 渲染（上一轮 review 的 MINOR 升级为必改）

现在 `tc.status === 'error'` 会落到 `'✓'` 分支（`AgentProgress.tsx:44`）—— fs 工具走不到那条所以当时无害，
MCP 一接进来 `isError:true` 就是常规事件，不改则**每次上游额度耗尽都显示成功**。

```tsx
const icon = isBuiltIn ? '🔍' : tc.status === 'running' ? '⏳' : tc.status === 'error' ? '✗' : '✓'
const cls = tc.status === 'error' ? 'is-error' : tc.status === 'done' ? 'is-done' : 'is-running'
```

`AgentProgress.css` 加 `.tool-run.is-error { color: var(--app-error); }`。
事后（消息气泡里）不需要改：`MessageList.tsx:62` 已经把 tool result 文本渲染出来，错误文案自然可见。

### 8. 前端：`components/ChatInterface.tsx` 逐 server 开关

`.composer-toolbar` 左侧 `<div>`（纸夹按钮旁，`ChatInterface.tsx:113-127`）加一个入口：

```tsx
<Popover trigger="click" placement="topLeft" content={<McpServersPanel />}>
  <Button type="text" className="mcp-btn" icon={<ApiOutlined />} aria-label="外部工具" />
</Popover>
```

`McpServersPanel`（同文件或 `components/McpServersPanel.tsx`）：`getServers()` 每项一行
`label` + antd `Switch`（`size="small"`），无 server 时显示一句"未接入外部工具"。样式进 `ChatInterface.css`，
颜色取 `--app-*`、尺度取 `tokens.css`；沿用纸夹按钮的 `type="text"` 形态。切换立即写 localStorage 并更新一个
本地 state（**不新增 store 分片**，它不是会话状态）。

### 9. 测试

- 新增 `agent/__tests__/externalTools.test.ts`：命名空间拼接、`getDefinitionsFor` 只影响副本且 fs 工具恒在、
  关闭时 executor 返回"未启用"且 `isError`、fetch 失败不抛、localStorage 抛异常时降级为默认值。
- 新增 `agent/__tests__/toolRegistry.test.ts`（当前没有）：`executeDetailed` 对 string / ToolResult / 抛异常
  三种 executor 的返回，`has` 与 `getDefinitions` 未被扩展破坏。
- `toolProgress.test.ts` 补一条：`done → error` 不回退、`running → error` 生效（锁住 RANK 语义）。
- `runAgentLoop` 的 error 路径靠离线假上游覆盖（步骤 10）。
- **离线假 MCP server**：`node_modules/.scratch/fake_mcp_server.py`（Python，同一份逻辑两种挂载形态：
  `/mcp` 走 Streamable HTTP、`/sse` 走 SSE），可注入：慢响应（>30s）、`isError:true`、超长结果（>8,000 字符）、
  握手失败。前端 `VITE_API_BASE_URL` 指向本地 uvicorn（它再指向假 MCP），整条链零模型 token 可验。

### 10. 验证顺序

1. `pnpm --filter web test:run` + `pnpm build`（前端纯逻辑）
2. Python 侧：`node_modules/.scratch/` 脚本直连假 server，逐条打印 `list_tools` / `call_tool` 结果，验证双传输、
   截断标记、`is_error` 透传、超时文案
3. 真机：`curl` 本地 uvicorn 的 `/api/mcp/tools` 与 `/api/mcp/call`（打真实百炼，**只消耗 MCP 配额、不消耗模型 token**），
   amap 与 AntV 各调一次；预期"部分接口 `USER_DAILY_QUERY_OVER_LIMIT`"仍算接入成功
4. 浏览器（无头实例 + 假上游，见 AGENTS.md 已知坑 6）：`isError` → ✗ 的行、开关关掉后 definitions 里不含该 server、
   跨会话切换时进度只落在发起会话
5. 端到端"模型真的自主调了 amap"需要真实模型调用，**要他单独点头才跑**

## 验收标准

- [ ] `pnpm --filter web test:run` 全绿（现 52 用例 + 新增），`tsc -b` 无错，`pnpm build` 绿
- [ ] `GET /api/mcp/tools` 对两个已开通 server 都返回非空工具清单，`name` 全部形如 `mcp__<service>__<tool>`，响应中不含 API key
- [ ] 关掉 AntV（默认即关）时，发给模型的 `tools` 数组里**没有** `mcp__antv-*` 任何一项（浏览器实测请求体）
- [ ] 模型幻觉调用一个未启用的外部工具 → tool result 为"外部工具未启用…"，进度行显示 ✗，主循环继续下一轮不崩
- [ ] 上游返回 `isError:true` → 进度行 `✗` + `.is-error` 颜色，**不再出现 ✓**（离线假 server 实测）
- [ ] 结果 > 8,000 字符 → 截断且带"（结果已截断，原内容 N 字符）"，前后端拿到的都已限界
- [ ] 假 server 睡 40s → 约 30s 返回超时文案（`isError:true`），界面不冻结，另一条会话不受影响
- [ ] 单个 server 握手失败时 `/api/mcp/tools` 仍 200，另一 server 的工具正常返回
- [ ] 开关刷新页面后保持；localStorage 写入失败（隐私模式模拟）时生成流程不报错
- [ ] **跨会话**：A 会话生成中外部工具进度只出现在 A 的分片；切到 B 无进度节点；A 那一路的 `onProgress` 仍只写 A（`streamSeq` 守卫未被绕过）
- [ ] **跨会话**：外部工具执行前后 `workspaceStore` 任何会话的分片都无新增/变更文件（外部工具只读，落库时机不变）
- [ ] 生成中途翻开关：在飞那轮不受影响，下一轮才按新开关发 definitions（步骤 3 的语义，实测一次）
- [ ] 无 `VITE_API_BASE_URL`（dev proxy 模式）时应用仍可正常生成，只是没有外部工具，且无未捕获异常
- [ ] 真实百炼 `amap-maps` 的 `maps_geo` 经 `/api/mcp/call` 返回经纬度文本（零模型 token）
- [ ] `AGENTS.md` 增补：状态不变量一节补一句"外部工具是全局注册 + 全局开关，不是会话状态；外部工具永不写工作区"，已知坑补 dev proxy 未覆盖 `/api/mcp`
