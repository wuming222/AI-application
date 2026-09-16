# 2026-09-16 需求记录

## 工具调用阶段界面像卡死：思考文字吐完后不动了

### 问题描述
第一轮 thinking/正文全部输出后，页面就停在「第 1 轮思考中…」不再变化，也没有出现本该有的「执行工具」。实际生成并没有停 —— 是这段时间前端收不到任何可渲染的事件。

### 机制（代码级）
SSE 事件里只有两类会 `yield` 给上层：`response.output_text.delta` 与 `response.reasoning_text.delta`。函数调用这条路是静默的：

```
response.output_item.added(function_call)  → 只写 pendingFunctionCalls，不 yield   (responses.ts:149-159)
response.function_call_arguments.delta ×N  → 只累加 arguments 字符串，不 yield      (responses.ts:161-167)  ← 卡住的这段时间
response.completed                         → 才 yield { done:true, tool_calls }    (responses.ts:193-199)
```

而 `runAgentLoop` 里 `step.status = 'tool-call'` 与工具行是在 for-await **结束之后**才设置的（`runAgentLoop.ts:116-122`）。所以模型开始逐个 token 生成 `write_file` 的参数（一个完整 HTML 应用几千 token）后，`emitProgress()` 一次都不会被调用，界面就冻在最后一条 thinking 上。

对照：`web_search` 内置工具之所以有状态，是因为它在 `added / in_progress / searching / completed` 每个事件都 yield 了一次（`responses.ts:170-191`）。函数调用没有这层待遇。

### 已确认的处理决策
1. **状态级反馈**：在 `response.output_item.added`（`function_call`）时就 yield，让界面立刻从「思考中」切到「第 1 轮执行工具：⏳ `write_file`」；不做百分比/字节数进度
2. **无事件超时兜底**：超过约 30s 没有新进展时，在进度区给一条可见提示，**不自动中断**，保留「停止」按钮由人决定（计时口径见下）
3. **清理 `thinkingText`**：见下方订正 —— 它其实是个死字段

### 写文档后核对代码，三处订正（以本节为准）

**① 决策 3 的"重复显示"判断是错的。** `thinkingText` 全项目**只写不读**：`runAgentLoop.ts:73` 写入，`AgentProgress.tsx` 只渲染 `step.reasoningText`（且仅 round 1，见 `AgentProgress.tsx:21`）。屏幕上那段 thinking 文字是 `reasoningText`，它本来就是按 step 累加的（`step.reasoningText = (step.reasoningText ?? '') + chunk.reasoning`），**不存在跨轮重复**。
所以 `step.thinkingText = accumulated` 这个跨轮累加只污染数据不影响界面。处理改成二选一，不要按原计划"改成本轮文本"了事：
- 直接把 `thinkingText` 从 `AgentProgressStep`（`types.ts:28`）删掉，`accumulated` 仅用于返回值 `finalText`；
- 或保留并接进 UI 显示本轮正文。
倾向删除 —— 无消费方的字段留着只会继续骗人。

**② 切到 `tool-call` 会把已显示的 thinking 文字整块抽走，是新回归。** `AgentProgress.tsx` 里 reasoning 块嵌在 `step.status === 'thinking'` 分支内部（第 15-27 行）。决策 1 一执行，状态离开 `thinking` → 用户刚看完的那段推理文字**直接消失**，界面从"冻住"变成"内容被撤回"，比现在更怪。
要求：reasoning 块的显示条件与 `status` 解耦（`thinking` / `tool-call` / `done` 都保留本轮已产出的 reasoning），并把这条写成验收用例。

**③ 超时的计时口径必须定义清楚，否则决策 2 打不到目标。** 有两种完全不同的"卡住"：
- **上游真没字节**：`reader.read()` 一直不返回 → 只能靠 wall-clock 计时发现。
- **有字节但没有可渲染事件**：`function_call_arguments.delta` 正常在流，只是 `responses.ts` 不 yield。

决策 1 落地后，第二种情况被 `added` 那一次 yield 覆盖了（立刻切到"执行工具"），所以**计时器要挂在 UI 侧**：从 `chatStore` 上一次 `onProgress` 变化起算，超过阈值就提示"已 N 秒无新进展"。挂在 `responses.ts` 的事件循环里数帧是错的 —— 那时帧一直在来，永远不会超时。

另外，`responses.ts:155` 从 `added` 事件里直接读了 `event.item.arguments`，说明上游**可能**把完整参数一次性放进 `added`（而不是分片 delta）。这两种形状下"卡住的时长"来源不同，实现要都能出进展提示，不能假设一定有 delta 流。

### 实现约束（做的时候别踩）
- 沿用 `built_in_tools` 通道要注意 `runAgentLoop.ts:78-95` 的合并逻辑是**按名字** `find`：
  - 先来了 `web_search` 再来 `write_file`，走 `else` 分支只会更新同名项 → **新的函数调用会被静默丢弃**；
  - 一轮里两个同名工具（两次 `write_file`）会互相错位。
  建议改为按 `call_id` 对齐，或给函数调用单开一条 chunk 字段（`pending_tools`），不要硬塞进 `built_in_tools` 的语义里。
- `added` 时刻 `args` 还是空的，因此 `AgentProgress.tsx:34` 的 `path` 显示不出来 —— 「执行工具：⏳ write_file」没有文件名是可接受的，但不要在 UI 上留个空括号。
- **不要把"参数流完"当成"工具执行完"。** `running` → `done` 只应由 `registry.execute` 返回来翻转（`runAgentLoop.ts:140-143` 已经是这个位置）。若在 `response.completed` 就标 `done`，界面会在文件还不存在时先显示 ✓，属于说谎。
- `runAgentLoop.ts:116-121` 现在用 `toolCalls.map` **整表覆盖** `step.toolCalls`，会把 `added` 时建立的 running 行重置一遍。合并而非覆盖。

### 待办
- [ ] 出 SDD（含上面三处订正与实现约束）
- [ ] `responses.ts`：`function_call` 的 `added` 事件 yield 工具状态（新通道 `pending_tools` 或改造 `built_in_tools`，按 `call_id` 对齐）
- [ ] `runAgentLoop`：收到即把该步置为 `tool-call` 并标 `running`，`registry.execute` 返回后才 `done`；与已有 `toolCalls` 合并不覆盖
- [ ] `AgentProgress`：reasoning 块与 `status` 解耦，跨状态保留
- [ ] 无事件计时挂在进度侧（wall-clock，阈值取常量，文案可见；不自动 abort）
- [ ] 处置 `thinkingText`（默认：删字段）
- [ ] 事件 → step 状态映射补单测（纯逻辑，可测：`added` 不丢、同名不串、completed 不改 done）
- [ ] 浏览器实测：生成一个应用，确认思考结束后立刻出现「执行工具：⏳ write_file」且 thinking 文字不消失，文件写完后转 ✓

### 已知未验证的风险（本轮不处理，先记下来）
- `function_call_arguments.delta` 靠 `event.item_id` 回查 `pendingFunctionCalls`（`responses.ts:161-167`）。若上游这个字段与 `added` 时的 `item.id` 不一致，参数会**静默丢失**、工具拿到空 `arguments`。要确认得抓一次真实 SSE，本轮按决定不做实测
- 上游究竟是否分片下发 `function_call_arguments.delta` 未实测（见订正 ③ 末），影响"卡住的这段时间到底有没有字节"
- 逐字流式正文按会话回传仍不在范围内（与 `preview-error-capture`、`session-state-isolation` 里记的是同一件事）
