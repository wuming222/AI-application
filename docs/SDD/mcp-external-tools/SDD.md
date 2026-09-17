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

> **实测结论（已按上面的 fallback 落地）**：装到的 `mcp` 是 2.2.0，入口已改名
> `streamable_http_client` 且返回 `TransportStreams`（与文档里的 `streamablehttp_client` + 三元组不一致），
> 依赖栈是 `httpx2`，与服务端在用的 httpx 0.28 并存。我们只需要三个 JSON-RPC 方法，
> 因此两种传输都走手搓：`app/mcp/client.py` 约 200 行，同一函数签名，`trust_env=False` 显式可控。
> 双传输真机冒烟见步骤 10 第 3 条（amap 15 个工具 / AntV 25 个工具）。

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
`[非文本内容: image]` 占位而不是丢弃，模型需要知道有东西没拿到）；**只有**一个文本块都没拿到时才兜底
序列化 `structuredContent`（实测 amap 的 JSON 就装在 `content[].text` 里，原样回传即可）。
`isError` 直接透传。截断也在这里。

> 评审后加固：`content` 不是 list、或元素不是对象时一律收窄跳过而不抛 —— `call_tool` 的
> docstring 承诺"返回 `{text,is_error}`，不抛异常"，畸形回复不该靠路由那层 `except Exception` 兜。

> **超时的实现方式（偏离原计划，理由记录）**：没用 `asyncio.timeout` —— `pyproject.toml` 声明支持
> Python 3.10，且被取消的任务里 `finally` 还得再 `await` 一次收尾连接，容易变成"超时了但关不掉"。
> 改成三层确定性上界：httpx 的 connect/read 超时兜"连不上、一个字节都不发"；读流时**每行**检查一次
> 截止时间，兜"持续发心跳却从不回你要的那条帧"（这种上游会不断重置 httpx 的 read 超时，单靠它兜不住）；
> `MAX_EVENTS_PER_REQUEST = 2000` 帧计数上界兜"疯狂发帧"。三条路一律转成 `McpError`，
> 调用方拿到的是可恢复文本而不是异常。**实测是按比例缩小的预算**：给永不回匹配帧的 `slow` 工具传
> `timeout=2.0`，实测 2.7s / 2.6s（两种传输各一次）返回 `is_error:true` 的
> `外部工具调用失败：调用超时（2s 内未返回结果）`而不是抛异常。
> 生产默认的 30s 与前端 35s 这一档**没有做全尺寸实测**，只有代码路径同构这一层保证。

### 3. 服务端路由：`packages/server/app/routes/mcp.py`

- `GET /api/mcp/tools`（另接 `?refresh=true` 绕过缓存）→ `{ servers: [{id,label,defaultEnabled}], tools: [{ name, service, tool, description, parameters }], errors: [] }`
  - `name` 已加命名空间：`mcp__<service>__<tool>`（防与 5 个 fs 工具撞名，也让模型一眼看出这是外部能力）；
    同时保留裸 `tool` 字段，`/call` 要用它回指上游工具名。
  - 进程内 TTL 缓存 10 分钟（`TOOLS_TTL_SECONDS`）；**逐 server 容错**：某个 server 握手失败时它贡献 0 个工具
    并在响应里带 `errors: [{service, message}]`（message 截 300 字符），绝不让整个端点 500（否则 AntV 配额耗尽
    会连带 amap 一起不可用）。**有旧清单时先回落到旧清单** —— 上游抖一下不该让能力从界面上消失。
  - 两个 server 的握手用 `asyncio.gather` **并发**（评审后改动）。原先的串行 `for` 循环里端点耗时是各
    server 超时之和（`list_tools` 20s × 2 = 最坏 40s），会顶穿前端那份 35s 的 abort —— 表现不是超时文案，
    而是"一个外部工具也没注册上"且每轮重演。并发后总和 = 最慢那一个（20s），清单顺序仍按 `MCP_SERVERS`。
- `POST /api/mcp/call` body `{ service, tool, arguments }` → `{ text, is_error }`，**恒 200**（错误在 body 里，
  前端不需要区分 HTTP 异常与工具异常）。未知 service 也是 `is_error` 文本。
- `main.py` 里 `app.include_router(mcp_router)`。CORS 白名单不动（5173 已在内）。
- ~~`pyproject.toml` 加 `mcp>=1.9`~~：**未加依赖**。步骤 0 的结论是手搓客户端，只用已在依赖里的 httpx。

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
const ENABLEMENT_KEY = 'mcp-servers-enabled'   // module 私有，不外导（避免别处再开一个 key）
const REQUEST_TIMEOUT_MS = 35_000              // 清单与调用两种请求共用，比服务端上界宽一档
export function loadExternalTools(): Promise<void>      // 幂等：module-level readyPromise；失败时把 promise 置空，下一轮可重试
export function externalToolsReady(): Promise<void>
export function getExternalToolsSnapshot(): { servers, enabled }  // 引用稳定：无变化时同一对象
export function subscribeExternalTools(fn): () => void   // 返回取消订阅；面板靠它同时响应"加载完成"和"翻开关"
export function isServerEnabled(id): boolean
export function getEnabledServiceIds(): Set<string>      // localStorage 覆盖 defaultEnabled
export function setServerEnabled(id, on): void           // 写 localStorage + 通知订阅者
```

与原草稿的差别：`getServers()` 换成了 **snapshot + subscribe** 一对，因为 `loadExternalTools()`
在 `App` 挂载时发起、完成时间不确定，面板必须能在"清单后到"时重渲染，而它不是会话状态、
不该进任何 store 分片 —— 一个 module-level 的订阅就是这一处需要的全部机制。

- fetch 基址同 `responses.ts:92`：`import.meta.env.VITE_API_BASE_URL || ''`。**dev proxy 模式下
  `/api/mcp` 不在 `vite.config.ts` 白名单里**，所以要么给 proxy 加一条，要么（当前使用的模式）
  `VITE_API_BASE_URL` 指向 8000 就自然通。v1 只保证后者，前者作为已知限制记录（已写进 AGENTS.md 联调一节）。
- 每个工具 `registry.register(def, executor, { mcpService: service })`，executor：
  1. `if (!isServerEnabled(service)) return { text: '外部工具未启用：该 MCP 服务当前在输入框的外部工具开关里是关闭状态。', isError: true }`
     —— 挡的是模型凭上一轮上下文幻觉调用。
  2. `POST /api/mcp/call`，`AbortSignal.timeout(CALL_TIMEOUT_MS)`（比服务端 30s 宽一档，让服务端先给出更可读的超时文案）。
     `/api/mcp/tools` 用同一个 35s 上界。
  3. 网络层异常 / 非 2xx → `{ text: '外部工具调用失败：<msg>', isError: true }`，**不抛**。
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
  <Tooltip title="外部工具">
    <Button type="text" className="mcp-btn" icon={<ApiOutlined />} />
  </Tooltip>
</Popover>
```

`McpServersPanel` 独立成 `components/McpServersPanel.tsx` + `McpServersPanel.css`（不是塞进 ChatInterface.css，
它有自己的行/间距节奏）。状态源只有一个：`useSyncExternalStore(subscribeExternalTools, getExternalToolsSnapshot)`，
每项一行 `label` + antd `Switch size="small"`，清单为空时一句"未接入外部工具"。

**没有再做一份独立的"总闸"布尔值** —— 全部 server 关掉就是总闸关。存两份开关会出现
"总闸开着但唯一启用的 server 被关了"这类自相矛盾的显示，而它没有任何一种情况能提供价值。
切换只写 localStorage 并通知订阅者，**不新增 store 分片**（它不是会话状态）。

### 9. 测试（已落地）

- `agent/__tests__/externalTools.test.ts`（**16 用例**）：schema/description 透传、与 fs 工具共存、
  加载失败时一个外部工具都不注册、**默认开关下发给模型的清单里没有真实 id `mcp__antv-visualization-chart__*`**、
  **dev proxy 形状（200 text/html，`res.json()` 抛 `SyntaxError`）退化成没有外部工具而不是报错**、
  失败后下一轮允许重试、快照引用稳定、`defaultEnabled` 初值、
  翻开关只写一个 localStorage key 并通知订阅者、"刷新"后偏好读得回、
  `localStorage.getItem` 抛异常时降级为服务端默认值且不抛、executor 请求体形状 `{service,tool,arguments}`、
  关闭时 executor 不发请求、`is_error:true` 透传、网络异常与 HTTP 502 都转 `isError`。
- `agent/__tests__/toolRegistry.test.ts`（**8 用例**，此前没有该文件）：fs 工具在任何开关下恒在、
  按 service 筛选、**筛选只作用于发出去的副本**（`registry.has()` 仍为 true）、
  `executeDetailed` 对 string / 抛异常 / 未知工具三种情况的返回、`execute()` 仍返回纯文本。
- `toolProgress.test.ts`（**+2 用例**）：`running → error` 生效、`error` 不被后到的快照打回 `running`。
- 合计 `pnpm --filter web test:run` = **78 用例 / 12 文件全绿**；`pnpm build`（`tsc -b`）与 `pnpm --filter web lint` 均通过。

### 10. 离线真链路（零模型 token）

四层，从内到外，每层都可重跑：

1. **Python 客户端 + 路由**：`node_modules/.scratch/fake_mcp_server.py`（同一份逻辑两种挂载形态，
   `/mcp` 走 Streamable HTTP、`/sse` 走 SSE，可注入永不回复的 `slow`、`isError`、12,000 字符超长结果、
   500 故障）+ `node_modules/.scratch/mcp_client_check.py` 驱动 → **27 项全过**（评审后从 21 项扩来）：
   双传输各 5 个工具、截断后 `len=8021` 且尾带`\n（结果已截断，原内容 12000 字符）`、
   `isError` 透传、非文本块转 `[非文本内容: image]`、
   超时两个档位都实测：小预算 2.0s → 2.7s / 2.6s（`mcp_client_check.py`），生产预算 30.0s → **30.7s / 30.6s**
   （`mcp_timeout_30s.py`），两种传输各一次、都转成可恢复文本而不是抛出、
   单 server 故障时端点仍 200 且带 `errors[]`、TTL 缓存不打重复握手（`hits` 只有故障那个 =2）、响应不含 key。
   评审后新增的 6 项：3 个 server 各 `sleep(1.5)` 的替身下端点 **1.51s** 而非 4.5s（并发）、
   并发下清单顺序仍按 `MCP_SERVERS`、`content` 不是 list 与块不是 dict 时 `_flatten` 不抛、
   上游用字符串 id 回复也能匹配且 id 不匹配时不误取。
2. **真机路由冒烟（只消耗 MCP 配额，零模型 token）**：本树起 uvicorn 后
   `GET /api/mcp/tools` → 200，`amap-maps` 15 个 + `antv-visualization-chart` 25 个，
   `name` 全部 `mcp__<service>__<tool>`，`errors: []`，59,808 字符响应体里正则扫不到 `sk-*`；
   `POST /api/mcp/call` `maps_geo("杭州市西湖")` → `is_error:false`、
   `location":"120.130396,30.259242`、`citycode":"0571"`。
   并发改动（[M1]）的真机计时用 `node_modules/.scratch/mcp_concurrency_real.py` 取：
   solo `amap-maps` **1.09s** / solo `antv-visualization-chart` **1.34s** → 端点 **1.80s**，串行会是 **2.44s**。
   这组数字是在**干净 worker** 上重取的 —— 第一轮取数时 `--reload` 只打了 `Reloading...` 却没起新进程
   （见 AGENTS.md 已知坑 7），那份计时属于旧代码，已作废重跑。
3. **浏览器端到端**：`node_modules/.scratch/fake-mcp-upstream.mjs`（一个进程同时顶掉
   `/api/llm/responses`（按 Responses 事件顺序下发 reasoning → `output_item.added(function_call)` →
   `function_call_arguments.delta` → `completed`）、`/api/sessions` CRUD、`/api/mcp/tools`、`/api/mcp/call`，
   外加 `/__probe/*` 把"实际发给模型的 tools 名"和"实际发生的 MCP 调用"回读出来）
   + `node_modules/.scratch/cdp-mcp-probe.mjs`（无头 Chrome + CDP，**页内 setInterval 采样器**逐帧记
   `.tool-run` 的图标/class/颜色）→ **26 项全过**；评审改的 `REQUEST_TIMEOUT_MS` 改名与
   `runAgentLoop` 的 `clearTimeout` 都在这条链上（`runAgentLoop` 无单测覆盖，只能靠这一层），
   改完**重跑仍 26/26、`页面告警: []`**。
4. **端到端"模型真的自主调了 amap"**：**没跑**。它需要一次真实模型调用，按约定要他单独点头。

## 验收标准

- [x] `pnpm --filter web test:run` 全绿（**78 用例 / 12 文件**），`tsc -b` 无错，`pnpm build` 绿，`pnpm --filter web lint` 0 error（1 条 `Sidebar.tsx:155` 的 exhaustive-deps 警告是既有的，不在本分支范围）
- [x] `GET /api/mcp/tools` 对两个已开通 server 都返回非空工具清单（真机：**amap-maps 15 个 / antv-visualization-chart 25 个**），`name` 全部形如 `mcp__<service>__<tool>`（逐个前缀断言通过），59,808 字符响应体里正则扫 `sk-*` 为空
- [x] 关掉 AntV（默认即关）时，发给模型的 `tools` 数组里**没有** `mcp__antv-visualization-chart__*` 任何一项 —— 真实 service id 的排除由单测锁（`默认开关下发给模型的清单里没有任何 AntV 工具，amap 的在`）；浏览器侧用等价的默认关 server `fake-sse` 实测请求体（`/__probe/llm-requests` 回读），关掉时不在、打开后下一轮才在
- [x] 模型幻觉调用一个未启用的外部工具 → tool result 为"外部工具未启用…"，进度行显示 ✗，主循环继续下一轮不崩（浏览器实测：回给模型的文本含"外部工具未启用"，该行 `✗`，本轮正常收尾、输入框恢复可用）
- [x] 上游返回 `isError:true` → 进度行 `✗` + `.is-error`，**不再出现 ✓**（浏览器逐帧采样：⏳ → ✗，`className` 含 `is-error`，`getComputedStyle().color` 取到主题错误色）
- [x] 结果 > 8,000 字符 → 截断且带"（结果已截断，原内容 N 字符）"（两种传输各一次：`len=8021`、尾串正是这句标记；前端拿到的已限界）
- [x] 超时 → 可恢复文本而不是冻结。**分开实测的两半**：服务端上界按生产预算跑（假 server 永不回匹配帧 + `timeout=30.0`）→ **30.7s / 30.6s**（两种传输各一次）返回 `外部工具调用失败：调用超时（30s 内未返回结果）` 且 `is_error:true`；界面不冻结 + 另一条会话不受影响这一半用 9s 的慢调用在浏览器里测（⏳ 一直在、期间当前会话输入框不被锁、切走再切回进度还在）。
- [x] 单个 server 握手失败时 `/api/mcp/tools` 仍 200，另一 server 的工具正常返回（`fake-broken` 恒 500 → `errors:[{service:'fake-broken',…}]` 且另外两个 server 的 10 个工具照常返回）
- [x] 开关刷新页面后保持；localStorage 读写抛异常时生成流程不报错（浏览器实测"重开面板读得回同一值"且偏好只落在 `mcp-servers-enabled` 一个 key；单测用 `Storage.prototype.getItem` 抛异常 → 退回服务端默认值）
- [x] **跨会话**：A 会话生成中外部工具进度只出现在 A 的分片；切到 B 看不到 A 的行；A 那一路 `onProgress` 仍只写 A（浏览器逐帧断言 6 项：每一帧只有一行该工具、A 的会话里从头到尾没出现过 `mcp__` 行、切回 B 时它的 ⏳ 还在）
- [x] **跨会话**：外部工具执行前后 `workspaceStore` 任何会话都无新增文件（浏览器跑完整轮后逐条 `GET /api/sessions/:id/workspace` 回读，`keys.length === 0` 全票通过）
- [x] 生成中途翻开关：在飞那轮不受影响，下一轮才按新开关发 definitions（浏览器实测：翻闸前发出的那一路仍把 `slowcall` 跑完并正常收尾，下一轮回读的 `toolNames` 里已无该服务）
- [x] dev proxy 模式（`VITE_API_BASE_URL` 为空）下没有外部工具且无未捕获异常 —— 退化路径两层都测了：真实 vite 实测 `GET /api/mcp/tools` 回 **200 text/html（SPA 外壳）**；单测把这种响应形状（`res.json()` 抛 `SyntaxError`）打进去，断言 `loadExternalTools()` 仍 resolve 且一个外部工具都不注册。**注**：该模式下"仍能完整生成"依赖既有的 dev proxy 通路，与本轮改动无关，未重复验全链路。
- [x] 真实百炼 `amap-maps` 的 `maps_geo` 经 **`POST /api/mcp/call`**（HTTP 端点，不是直接调客户端）返回经纬度：`is_error:false`，文本含 `"location":"120.130396,30.259242"`（零模型 token，只消耗 MCP 配额）
- [x] `AGENTS.md` 增补：架构地图补 `agent/externalTools.ts` + `app/mcp/` + `routes/mcp.py`；状态不变量补"外部工具是全局注册 + 全局开关，不是会话状态；外部工具永不写工作区"；联调一节补"dev proxy 未覆盖 `/api/mcp`，且它的失败形态是 SPA 外壳不是 404"；用例数与 chunk 体积同步为实测值

### 未做（需要他点头）

- [ ] 端到端"模型真的自主选了 amap 的工具并调用成功"。这一步要一次真实模型调用（`qwen` + 真 MCP），
      零 token 的替代验证已经把协议、筛选、渲染、跨会话四件事分别钉住了，缺的只是"模型会不会想到用它"。

## 评审（personal-review）

基线 `main` @ merge-base `89e3a8e`，22 文件 +1447/−22（文档 320 行，代码 1127 行；未过 2000 行阈值，
无跳过范围）。**BLOCKER 0 / CRITICAL 0 / MAJOR 2 / MINOR 6**，其中 5 条已改、3 条不改并记录理由。

已改：

| 级别 | 问题 | 位置 | 改法与证据 |
|---|---|---|---|
| MAJOR | 两个 server 串行握手，冷启动最坏 40s（20s × 2），顶穿前端 35s 的 abort → 表现成"一个外部工具也没注册"且每轮重演 | `routes/mcp.py` `list_external_tools` | 抽出 `_server_tools` 协程 + `asyncio.gather` 并发；假 server（3 个各 `sleep(1.5)`）实测 **1.51s** 而非 4.5s，真机 solo 1.09s / 1.34s → 端点 **1.80s**（串行 2.44s） |
| MAJOR | `call_tool` docstring 承诺"不抛异常"，但 `_flatten` 在 `try` 之外，`content` 非 list / 块非 dict 时 `AttributeError` 逃出，靠路由兜底才没 500 | `mcp/client.py` `_flatten` | 两处形状收窄；单测式检查 `{"content":"不是列表"}` → `("(空结果)", False)`、畸形块混有效块 → 只留有效文本 |
| MINOR | JSON-RPC 允许字符串 id，`payload.get("id") == want_id` 严格比较会把上游回的 `"1"` 判成含糊的"无回复" | `client.py` `_pick_rpc` | 两侧 `str()` 归一；加"字符串 id 能匹配 / id 不匹配不误取"两项检查 |
| MINOR | 清单先到时 `Promise.race` 里那个 2s 兜底定时器不被清理，挂着待触发句柄 | `runAgentLoop.ts` | 存 `waitTimer` 并在 `finally` `clearTimeout`；`runAgentLoop` **无单测覆盖**，改完靠浏览器层重跑 26/26 兜住 |
| MINOR | `CALL_TIMEOUT_MS` 同时管清单与调用两种请求，名字与注释只解释了前者 | `externalTools.ts` | 更名 `REQUEST_TIMEOUT_MS`，注释写清两条服务端上界（`call_tool` 30s、逐 server 清单 20s 且并发） |

不改（记录）：

- **`/api/mcp/call` 不做 tool 名白名单**：`{service, tool}` 原样透传，前端开关只筛 definitions 不构成服务端约束。
  当前两个 server 全为只读工具、CORS 只放开 5173~5178，风险有限；"开关是不是硬边界"这件事留给带用户自定义
  server 的版本一起解，否则现在加的代码没法覆盖后面必然要加的动态 server。
- **`trust_env=False` 写死**：为绕开本机系统代理 MITM TLS（已实测），换到必须走企业代理出网的机器会连不上，
  且只在 console 留一行 warn。等真出现第二台这样的机器再配置化。
- **`✗` 现在也覆盖内置工具失败**（未知工具名、执行器抛异常此前一律 `✓`）：这是修正不是回归，但会改变截图基线。

重跑（评审后）：Python 驱动 **27/27**、vitest **78/78（12 文件）**、`pnpm build` 绿（953 kB / gzip 309 kB）、
lint 0 error（1 条既有警告）、无头 Chrome **26/26 且 `页面告警: []`**、真机 `tools?refresh=true` 1.89s /
`maps_geo` `is_error:false`。

一条流程教训写进了 `AGENTS.md` 已知坑 7：`uvicorn --reload` 在 Windows 上会打 `Reloading...` 之后不再起新
worker，此时端点跑的还是旧代码 —— 上面第一轮真机计时就是这么取废的。
