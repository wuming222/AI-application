# 慧应用 MVP-0：纯对话闭环 - SDD

## 需求

验证整条 LLM 调用链路可用：用户发消息 → OpenAI 兼容 provider 流式响应 → UI 逐字渲染。这是后续 Agent 循环、虚拟 FS、预览等一切功能的地基——连模型都调不通的时候，写工具集纯属浪费。

MVP-0 **只做**：ChatInterface + 消息列表状态 + OpenAI 兼容流式调用（经 Vite dev proxy）+ Mock provider + SSE 解析与逐字渲染 + AbortController 停止。**不做**：虚拟 FS、工具执行、Agent 循环、上下文截断、iframe 预览、进度面板。这些留给 MVP-1。

API key 只存在于服务端环境变量，不进任何前端产物。Mock provider 使核心逻辑在无 key、断网条件下可完整跑通与测试。

项目采用 **pnpm workspace monorepo**，预留后端位置：

```
packages/
  web/      ← Vite + React（前端，MVP-0 全部代码在此）
  server/   ← 空壳占位，MVP-1 起放 LLM proxy / MCP proxy / BaaS 等
```

MVP-0 不依赖 server 包，dev 阶段 LLM 请求仍走 Vite proxy 转发到外部 OpenAI 兼容端点。

## 实现步骤

### 阶段 0：Monorepo 脚手架

- 根目录 `package.json`：`"private": true`，无 dependencies
- 根目录 `pnpm-workspace.yaml`：`packages: ["packages/*"]`
- `packages/web/`：`npm create vite@latest`（react-ts 模板），加 `zustand`
- `packages/server/`：仅 `package.json`（name: `@ai-app/server`，version: `0.0.0`）+ `README.md` 说明用途
- 根 `.gitignore`：`node_modules` / `dist` / `.env` / `.env.local` / `.claude/personal-workflow.json`
- `packages/web/.env.example`：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（占位，不含真值）
- `packages/web/vite.config.ts`：`server.proxy` 把 `/api/llm` 转发到 `LLM_BASE_URL`，在 proxy 的 `configure` 钩子里注入 `Authorization: Bearer <key>`
- 测试框架：`vitest`（装在 `packages/web`）

### 阶段 1：类型与 Provider `packages/web/src/llm/`

- `types.ts` — `Message { role, content }`、`StreamChunk { delta: string, done: boolean }`
  - MVP-0 不需要 ToolCall / ToolResult / images / rawParts，全部砍掉
- `providers/mock.ts` — 返回预设文本的异步生成器，模拟流式输出节奏（每 ~30ms yield 几个字符），用于离线开发与单测
- `providers/openai.ts` — `POST /api/llm/chat/completions`，`stream: true`
  - 按 `\n\n` 切帧 → 取 `data:` 行 → `JSON.parse` → yield `{ delta: choices[0].delta.content, done: choices[0].finish_reason != null }`
  - `[DONE]` 标记或 `finish_reason` 非空视为结束
  - JSON.parse 失败时跳过该帧并 console.warn，不抛异常中断流
- `router.ts` — `streamChat(messages, signal)`：根据 `VITE_LLM_PROVIDER`（`mock` | `openai`）选择 provider，返回 `AsyncGenerator<StreamChunk>`
  - 检查 `signal.aborted`，abort 时立即 return
  - MVP-0 不做重试（重试是 Agent 循环层的职责，不是单次调用的职责）

### 阶段 2：状态与 UI `packages/web/src/`

- `store/chatStore.ts` — Zustand：`messages: Message[]`、`isStreaming: boolean`、`sendMessage(text)` 、`abort()`
  - `sendMessage`：追加 user 消息 → 追加空 assistant 消息 → 调 `streamChat` → 逐 chunk 拼接 assistant content → 流结束后标记 `isStreaming = false`
  - `abort`：调 `AbortController.abort()`，UI 立即显示已中断状态
- `components/ChatInterface.tsx` — 输入框 + 发送按钮 + 停止按钮（仅 streaming 时显示）
- `components/MessageList.tsx` — 遍历 messages 渲染气泡，assistant 消息支持逐字追加（React 对 string state 的更新天然触发重渲染）
- `App.tsx` — 组合上述组件，居中布局

### 阶段 3：验收

- Mock provider 断网跑通：发一条消息，看到逐字输出的回复，点停止能中断
- 真实 provider：配 `.env` 后发消息，看到流式回复
- 构建产物 grep 确认无 API key

## 验收标准

- [ ] `pnpm --filter web dev` 后输入任意文字，MessageList 逐字显示模型回复
- [ ] Mock provider 模式下无 API key、断网也能完整跑通
- [ ] 流式传输中点「停止」，输出立即中断，UI 不再追加内容
- [ ] 连续发多条消息，历史完整保留且顺序正确
- [ ] `pnpm --filter web build` 后产物中 grep 不到 API key
- [ ] `pnpm --filter web test` 全绿（至少覆盖：mock provider 产出、SSE 帧解析、abort 信号传播）
- [ ] `packages/server/` 存在且含 `package.json` + `README.md`，monorepo 结构可用
