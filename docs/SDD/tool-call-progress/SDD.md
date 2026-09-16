# 工具调用阶段进度可见性 - SDD

需求原文：`docs/26-9-16/requirements.md`（含写完后核对代码的三处订正，本 SDD 以订正后为准）
分支：`feature/tool-call-progress`（base `main` @ `a74eaa7`）

## 需求

用户看到的是"思考文字吐完页面就冻住"。根因不是卡死，是**前端在这段时间一个可渲染事件都收不到**：
`responses.ts` 只对 `output_text.delta` / `reasoning_text.delta` 做 `yield`，`function_call` 的
`added` 与 `function_call_arguments.delta` 只往 `pendingFunctionCalls` 里塞字符串；而 `runAgentLoop`
要到 for-await 结束后才把 `step.status` 置成 `tool-call`（`runAgentLoop.ts:116-122`）。模型逐 token
生成 `write_file` 的几千 token 参数期间，`emitProgress()` 一次都不触发。

目标：函数调用从"开始被模型吐出"到"本地执行完成"全程有可见状态，且界面不出现"内容被撤回"或"提前打勾"两种新错。

范围边界：不做百分比/字节级进度；不自动中断；不改 SSE 协议与落库时机（仍整轮才落库）。

## 实现步骤

### 1. `llm/types.ts`：新增函数调用状态通道

```ts
export interface FunctionCallStatus {
  callId: string
  name: string
  args?: Record<string, unknown>   // 上游若在 added 里就给全参数，顺手带上，UI 能立刻显示文件名
}
// StreamChunk 增加
function_calls?: FunctionCallStatus[]
```

不复用 `built_in_tools`：那条通道在 `runAgentLoop.ts:88` 是**按名字** `find` 的，先 `web_search`
后 `write_file` 会走 `else` 分支把新调用静默丢掉，一轮两个同名工具也会错位。

### 2. `llm/providers/responses.ts`：`added` 时 yield 快照

在 `response.output_item.added` 且 `item.type === 'function_call'`（现 149-159 行，只写 Map）处，
维护一个与 `pendingFunctionCalls` 同步的 `Map<string, FunctionCallStatus>`，并
`yield { delta:'', done:false, function_calls: [...快照] }`（全量快照，语义与 `built_in_tools` 一致）。
`function_call_arguments.delta` 不 yield —— 那段时间界面已经有"执行工具 ⏳"行在显示，不需要逐字。

### 3. `agent/types.ts`：对齐键 + 删死字段

- `AgentToolCallInfo` 增 `callId?: string`（内置工具没有 callId，用 name 兜底作键）。
- **删 `AgentProgressStep.thinkingText`**。核对结论：全项目只写不读（写于 `runAgentLoop.ts:73`，
  `AgentProgress.tsx` 只渲染 `reasoningText`），留着只会继续误导改代码的人。`accumulated` 仍保留，
  它只服务返回值 `finalText`。

### 4. `agent/toolProgress.ts`（新，纯函数）：合并不覆盖

```ts
export function mergeToolCalls(
  existing: AgentToolCallInfo[] | undefined,
  incoming: { callId?: string; name: string; args?: Record<string, unknown> }[],
): AgentToolCallInfo[]
```
规则（每条都要能单测）：
- 键取 `callId ?? name`；同键就地更新，**不新增重复行**；
- 新键**追加**，不许因为已有其它工具而丢弃（治 1 里那个 bug）；
- 已有行的 `status` 只能前进：`running` 可被 `done`/`error` 覆盖，`done` **不回退**成 `running`；
- 传入 `args` 时补上（参数后到齐的情形），不传则保留原值；
- 不修改传入的 `existing` 数组元素之外的内容，返回新数组。

### 5. `agent/runAgentLoop.ts`：提前置状态、按 callId 收尾

- for-await 内新增分支：`chunk.function_calls` → `step.status='tool-call'` +
  `step.toolCalls = mergeToolCalls(step.toolCalls, chunk.function_calls)`，然后照常 `emitProgress()`。
- 现有 `built_in_tools` 分支（78-95 行）改走同一个 `mergeToolCalls`，去掉手写的按名 `find`。
- 116-122 行**整表覆盖**改为 `mergeToolCalls(step.toolCalls, toolCalls.map(...))`，
  这样 `added` 时建立的 running 行不会被重置一遍。
- 140-143 行的执行结果回填按 `callId === tc.id` 查找，不再用 `step.toolCalls[i]` 按下标 —— 合并后
  顺序可能与 `toolCalls` 不一致。
- `running → done` **只由 `registry.execute` 返回触发**。`response.completed` 不算完成。
- 删掉 `step.thinkingText = accumulated`（第 73 行）。

### 6. `agent/stallWatch.ts`（新，纯函数）：无进展计时

```ts
export const STALL_NOTICE_MS = 30_000
export function stallNoticeFor(idleMs: number, now: number): string | null
```
计时口径（重要）：**挂在 UI 侧，量"距上一次 progress 对象变化多久"**，不是量 SSE 帧数 ——
参数流式期间帧一直在来却没有任何 yield，数帧的计时器永远不会超时。
只产文案，不 abort、不改 `isStreaming`，「停止」按钮仍由人点。

### 7. `components/AgentProgress.tsx` + `.css`

- **reasoning 块与 `status` 解耦**：现在它嵌在 `status === 'thinking'` 分支里（15-27 行），
  一旦按步骤 5 提前切到 `tool-call`，用户刚看完的 thinking 文字会整块消失 —— 比冻结更怪。
  改成 spinner/「第 N 轮思考中」随 status 走，`step.round === 1 && step.reasoningText` 的正文
  在任何 status 下都保留。
- 「第 N 轮执行工具:」标题下的每一行仍是 `⏳ / ✓ / 🔍`；无 `path` 时不渲染空括号（现有条件已成立，加测试守住）。
- **收起而不是抽走**（实现后追加的需求）：`status === 'thinking'` 时 reasoning 展开、逐字可见；
  一旦进入 `tool-call` / `done`，同一份文本换到默认收起的 `<details>` 里，summary 为「💭 思考过程」。
  用原生 `details` 而不用 antd `Collapse` —— 与 `MessageList` 的工具气泡同形态，Collapse 的面板边框与内边距
  在这个 pill 容器里过重（已在 `.css` 里就地注明）。
- 组件内用 `useRef` 记 `progress` 最近一次变化的时刻，`setInterval(1000)` 驱动本地 state 重渲染，
  超过 `STALL_NOTICE_MS` 时多渲染一行提示（`第 N 秒无新进展，可能在生成大文件，可点停止`）；
  `useEffect` 卸载清 timer。progress 一变就重置基准，工具行转 ✓ 也会重置。

### 8. 单测

- `agent/__tests__/toolProgress.test.ts`：新调用不被同名前置调用挤掉（web_search→write_file）、
  同 callId 不重复成行、`done` 不被后续 `running` 覆盖、args 后到补齐、两个同名 write_file 不串。
- `agent/__tests__/stallWatch.test.ts`：29.9s 无文案、30s 出文案、传入更早的 `lastChangeAt` 才计时。
- `llm/__tests__/responses.test.ts`：stub `globalThis.fetch` 造一条 `added(function_call)` +
  `function_call_arguments.delta ×2` + `completed` 的 SSE 流，断言 `added` 时 yield 出
  `function_calls:[{callId,name}]`、delta 期间不再 yield、`completed` 时 `tool_calls` 参数完整。

### 9. 文档

`AGENTS.md`「状态不变量」补一条：**长时间无正文产出的阶段（尤其函数调用参数流式期间）必须有可见状态**，
新增 LLM 事件类型时同步检查它是否走到了 `emitProgress`。这是本次 bug 的通用形态。

## 验收标准（结果）

单测：`pnpm --filter web test:run` → 46 passed（原 32 + toolProgress 6 + stallWatch 4 + responses 4）；`tsc -b` 无错；`pnpm build` 绿（主 chunk 935 kB，+1.5 kB）。
浏览器：用离线假 Responses 上游（`node_modules/.scratch/fake-llm.mjs`，可控静默时长）+ 页面内采样器，**未消耗真实模型调用**。采样时间线（相对发送）：`t=7` 第 1 轮思考中 → `t=8` reasoning 文字出现 → `t=9` 「第 1 轮执行工具: ⏳write_file」且 reasoning 仍在同一步 → 静默期始终单行 → 结束后收起，会话里出现「🔧 执行工具 1 次 / 🔧 write_file: index.html」，预览 iframe `srcdoc` 982 字符。

- [x] 单测全绿 + `tsc -b` 无错 + `pnpm build` 绿
- [x] `added(function_call)` 后该会话分片 `steps[last].status === 'tool-call'` 且工具行 `running`（实测 t=9；`responses.test.ts` 断言 yield）
- [x] `function_call_arguments.delta` 期间不产生第二行（实测 40s 静默窗内恒为一行；`toolProgress.test.ts` 同 callId 不重复）
- [x] 先 `web_search` 后 `write_file` 两行都在（`toolProgress.test.ts`，锁住旧按名 find 的丢事件 bug）
- [x] 一轮内两个同名工具按 callId 各自独立（`toolProgress.test.ts`）
- [x] `AgentProgressStep` 无 `thinkingText`，`tsc` 通过即证明无消费方被破坏
- [x] `thinkingText` 已按方案删除（未保留为"本轮正文"，因无渲染方）
- [x] status 从 `thinking` → `tool-call` 时 round 1 的 reasoning 文本仍在 DOM（实测 t=9 同一 step 内两者并存）
- [x] 进入 `tool-call` 后该文本收起成单行「💭 思考过程」，点 summary 可展开（实测：容器高 782 → 142，静默 8s 恒为 142；`summary.click()` 后 `open=true`、高回到 1577、文本完整。测量时视口仅 618px 宽，绝对高度因此被放大，取的是同一内容下的前后对比）
- [x] 无进展提示渲染（实测：临时把阈值降到 3s 后，提示出现并逐秒 3→41 递增，进度变化后自动消失；`STALL_NOTICE_MS` 已改回 30_000 并由 `stallWatch.test.ts` 锁定）
- [x] 提示不改变 `isStreaming`、不触发 abort（实测：提示出现后 41s 仍在流，「停止」按钮仍可用）
- [x] **跨会话**：A 生成中切到 B → B 只有空态、无 progress 节点、无气泡、无 iframe；切回 A → 内容完整（实测）
- [x] 参数未齐时不渲染空括号（实测工具行为「⏳write_file」无 `()`）
- [ ] `response.completed` 与 `registry.execute` 之间不提前打勾：**仅由代码位置 + 单测（done 不回退）保证**，静默窗内未看到 ✓，但没有精确复现该边界
- [ ] **生成中点「停止」回到本轮开始**：本轮未重测（该路径未被改动，由 `chatStore.test.ts` 覆盖）
- [x] 浏览器实测「思考结束后立刻出现执行工具且 thinking 不消失」：以假上游完成；**真实模型（qwen）这一路径尚未实测**，且 `function_call_arguments.delta` 的 `item_id` 一致性仍未验证（见需求文档风险条）
