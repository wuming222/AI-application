# 会话状态隔离（切换不再串台） - SDD

## 需求
生成中切换会话会导致：显示旧会话内容、进度跑错界面、对话记录与生成的代码"丢失"、空态与进度同屏。

根因是**聊天状态是全局单槽**而界面是多会话，且工作区读写都隐式跟着"当前会话"走。三处同源泄漏：

| # | 泄漏点 | 位置 |
|---|---|---|
| 1 | `messages / progress / isStreaming` 全局单槽，后台循环收尾把旧会话数组盖到当前视图 | `chatStore.ts:27-30, 89-94` |
| 2 | 工具写入与读取走 `currentSessionId`，后台流的文件落进当前打开的会话；收尾 `saveWorkspace` 又按**全量覆盖**把它写回旧会话 | `workspaceStore.ts:31`、`chatStore.ts:103-104`、`sessions.py:172-176` |
| 3 | system prompt 里的"当前工作区文件清单"也取 `getCurrentFiles()` → 后台那一路问的是别的会话的文件 | `runAgentLoop.ts:22-30, 63` |

已确认决策：**后台继续跑并归属原会话**；**整轮才落库**（中断即丢这一轮）；**同时只一路**，在别的会话发送时先打断并提示。

## 实现步骤

### 1. chatStore 改成按会话分片
- 文件：`packages/web/src/store/chatStore.ts`
- 状态形状：
  ```ts
  interface ChatSlice { messages: Message[]; progress: AgentProgress | null; isStreaming: boolean }
  bySession: Record<string, ChatSlice>
  streamSessionId: string | null        // 全局最多一路
  ```
- 对外读取改成按会话取：`messagesFor(sid)` / `isStreamingFor(sid)` / `isEmptySession(sid)`
- `loadSession(sid)`：若 `streamSessionId === sid` → **跳过覆盖**（消息与工作区都不动，保住正在跑的那一路），只切 workspace 的当前会话指针；否则照旧拉取并写入该会话分片
- `sendMessage`：
  - 目标会话 `sid = currentSessionId`，历史只取 `bySession[sid]`（结构性消除串号）
  - 已有别的流在跑 → 先中止它并 `antdMessage.info('已中断另一条会话的生成')`；同一条会话已在跑则直接返回
  - `onProgress`、收尾 `set` 全部定向写回 `bySession[sid]`
  - 用一个自增 `streamSeq` 做代际标记：写回前比对，若这一路已被更新的一路顶替或会话已删 → 丢弃写入
  - 落库仍是整轮结束后一次：`saveMessages(sid, 新增部分)` + `saveWorkspace(sid, filesFor(sid))`
- `abort()`：中止当前这一路，并把该会话分片**回滚到本轮开始前的快照**（`messages.slice(0, prevCount)`、`progress:null`、`isStreaming:false`）

### 2. sessionId 显式贯穿到工具与工作区
- `agent/types.ts`：`AgentLoopOptions` 增加 `sessionId: string`
- `agent/runAgentLoop.ts`：
  - `buildSystemPrompt(files)` 接收文件表，由 `filesFor(sessionId)` 提供
  - `registry.execute(name, args, { sessionId })`
- `agent/toolRegistry.ts`：
  - `ToolExecutor.execute(args, ctx: { sessionId: string })`，5 个工具全部把 `ctx.sessionId` 传给 store
  - 顺带修掉 `listFiles` 的接口类型与实际返回不符（`string[]` vs 拼接后的 string）——消掉一个历史 `tsc` 错误
- `store/workspaceStore.ts`：`writeFile / readFile / listFiles / deleteFile / editFile / getCurrentFiles` 一律改成首参收 `sessionId`（`filesFor(sid)` 语义），不再内部读 `currentSessionId`

### 3. 视图按会话取状态
- `components/MessageList.tsx`：从 `useSessionStore` 拿 `currentSessionId`，`messages / progress / isStreaming` 都读该会话分片；**空态条件改为 `messages.length === 0 && !isStreaming`**（消除空态与「第 1 轮思考中」同屏）
- `components/ChatInterface.tsx`：`isStreaming` 换成 `isStreamingFor(currentSessionId)`
- `store/sessionStore.ts`：
  - `createOrReuseSession` 的空判定改用 `isEmptySession(sid)`（不再依赖 `messagesSessionId` 字段，该字段随分片化删除）
  - `deleteSession(sid)`：若 `streamSessionId === sid` 先 `abort()`；并从 `bySession` 丢掉该分片

## 边界
- 删除正在生成的会话 → 先中止，不向已删会话写库
- 切回生成中的会话 → 直接看到该分片的实时进度（分片一直在更新）
- 生成中新建/切换会话 → 不打断原流，原流的读写都仍指向它自己的 sessionId
- 被顶替或已删的一路 → 代际标记拦掉写回，绝不落到别的会话

## 明确不做
- 逐字流式文本按会话回传（`runAgentLoop` 目前只在轮次/工具边界回调，切回生成中的会话看到轮次进度，看不到正在吐的半截正文）
- 多路并发
- 中断时保存半轮内容

## 验收标准
- [ ] A 生成中切到 B（真实模型调用的端到端）：B 显示 B 自己的消息与空态，不出现 A 的「思考中」—— 视图层已用伪造分片验证，真实在跑的一路未测（要花一次模型调用）
- [ ] A 跑完切回 A：看到 A 的完整回复；A 的 workspace 文件仍是 A 的 —— 同上，依赖真实流
- [x] B 上直接发送：发给模型的上下文只含 B 的历史（单测断言 `runAgentLoop` 收到的 messages 为 `['B1','B 的新问题']`）
- [x] B 发送时 A 在跑：A 被中断并有 `已中断另一条会话的生成` 提示，A 分片回滚到本轮之前（单测）
- [x] A 生成中删除 A：先中止、不向已删会话写库、分片清掉（单测）
- [x] 切回生成中的会话不被 `loadSession` 覆盖：视图仍显示该会话进行中的消息，store 分片引用未变（浏览器实测）
- [x] 空态与进度不再同屏：切到空的 B 只见「发送一条消息开始对话」，无进度条；进度条只随 A 的分片出现
- [x] 工具与工作区按发起会话定向：`saveWorkspace` 收到的文件集是 A 自己的（单测）
- [x] system prompt 的文件清单取自该流所属会话（`buildSystemPrompt(filesFor(sessionId))`）
- [x] `pnpm --filter web test:run` 32/32 通过（新增 6 个隔离用例）
- [x] `npx tsc -b` 归零：顺带清掉 4 个历史类型错误，**`pnpm build` 首次通过**（只剩 934 kB chunk 体积告警）
