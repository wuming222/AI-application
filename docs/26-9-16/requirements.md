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
- [x] 出 SDD（含上面三处订正与实现约束）→ `docs/tool-call-progress/SDD.md`
- [x] `responses.ts`：`function_call` 的 `added` 事件 yield 工具状态（新开 `function_calls` 通道，按 `callId` 对齐，未复用 `built_in_tools`）
- [x] `runAgentLoop`：收到即把该步置为 `tool-call` 并标 `running`，`registry.execute` 返回后才 `done`；与已有 `toolCalls` 合并不覆盖（`agent/toolProgress.ts` 的 `mergeToolCalls`）
- [x] `AgentProgress`：reasoning 块与 `status` 解耦，跨状态保留
- [x] 无事件计时挂在进度侧（wall-clock，阈值取常量 `STALL_NOTICE_MS = 30_000`，文案可见；不自动 abort）
- [x] 处置 `thinkingText`：删字段
- [x] 事件 → step 状态映射补单测（`toolProgress.test.ts` + `responses.test.ts`：`added` 不丢、同名不串、completed 不改 done）
- [x] 浏览器实测：离线伪造 Responses 上游跑通全链路（`GAP_MS=90000` 静默窗口），确认思考结束后立刻出现「执行工具：⏳ write_file」且 thinking 文字未消失，无空括号，文件写完后转 ✓
- [ ] 真实模型（qwen）这一路径未实测：`added` 事件yield 与 `item_id` 一致性仍需一次线上抓包确认

### 已知未验证的风险（本轮不处理，先记下来）
- `function_call_arguments.delta` 靠 `event.item_id` 回查 `pendingFunctionCalls`（`responses.ts:161-167`）。若上游这个字段与 `added` 时的 `item.id` 不一致，参数会**静默丢失**、工具拿到空 `arguments`。要确认得抓一次真实 SSE，本轮按决定不做实测
- 上游究竟是否分片下发 `function_call_arguments.delta` 未实测（见订正 ③ 末），影响"卡住的这段时间到底有没有字节"
- 逐字流式正文按会话回传仍不在范围内（与 `preview-error-capture`、`session-state-isolation` 里记的是同一件事）

## 追问：显示工具时把首轮思考收起

第一条需求做完后，思考文字与工具行同时展开占住对话流。要求改成：**进入工具执行就把首轮思考收起来**，内容保留、可点开。
已实现（`9213c2c`，随分支合入 main）：`status === 'thinking'` 时展开逐字可见，切到 `tool-call` / `done` 时同一份文本换到默认收起的原生 `<details>`（summary 为「💭 思考过程」）。用原生 `details` 而非 antd `Collapse` 的理由就地注明：与 `MessageList` 的工具气泡同形态，Collapse 的面板边框在这个 pill 里过重。
验收：离线假上游实测容器高 782 → 142、`details.open === false`、点 summary 回到 1577 且文本完整。

## 流式期间对话流频繁抖动

### 问题描述
思考过程逐字输出时，对话流一直小幅来回蹭；从"思考中"切到"执行工具"的那一瞬间还会猛地弹一下。

### 机制（代码级）
抖的是**滚动**，不是列表长度：

- 改前 `MessageList.tsx` 的追滚 effect 是 `useEffect(..., [messages, progress])` → 每次触发 `scrollIntoView({ behavior: 'smooth' })`；
- `runAgentLoop.ts:103` 的 `emitProgress()` 是**每个 SSE chunk 调一次**，思考阶段每 token 一次，一秒十几到几十次；
- smooth 是异步补间动画，目标位置在动画中途被改写、又被下一次调用重新起坡 → 观感就是抖动。

`scrollIntoView` 另有一个毛病：它会连带滚动祖先可滚动容器，而外层是 `app-shell` 嵌套 flex，可能多滚一层。

### 结论：不上虚拟列表
`.message-list` 里一共几个气泡节点，不是渲染开销问题。虚拟列表治不了补间互相打断，只会给 key 稳定性和纯逻辑测试添负担，症状照旧。

### 方案（已确认）
改成直接操作 `scrollTop` 的瞬时赋值，配两个必要条件：

1. **贴底才追**：`scrollHeight - scrollTop - clientHeight < 阈值` 时才滚，用户往上翻看历史时不拽回底部；
2. **合帧**：`scrollHeight` 是读操作、会强制 flush layout，每秒十几到几十次同步赋值等于十几次强制重排；用 rAF 记账，一帧最多滚一次。

### 待办
- [x] 抽一个纯逻辑的滚动决策函数（输入 `scrollHeight/scrollTop/clientHeight` + 是否贴底，输出目标 scrollTop），便于单测
  → `packages/web/src/utils/chatScroll.ts`：`isPinnedToBottom`（阈值 120px）+ `followScrollTop`（不贴底返回 null，内容变矮不回填）
- [x] `MessageList` 换成 `listRef` + `scrollTop` 赋值 + rAF 待办标记，去掉 `bottomRef` 与 `scrollIntoView`
- [x] 补单测：贴底时追、用户上翻后不追、一帧内多次变更只滚一次
  → `pnpm --filter web test:run`：**52 passed**（`utils/__tests__/chatScroll.test.ts` 6 例：阈值边界 120/121、追滚目标、不贴底不追、到底不重复写、内容变矮不回填、不足一屏不滚）
- [x] 浏览器实测：离线假上游采样 `scrollTop` 序列，确认无补间回弹、静默期不再刷滚动、上翻不被拽回
  → 无头 Chrome（`--headless=new`）+ CDP 逐帧采样，改前/改后跑同一套脚本（`node_modules/.scratch/cdp-scroll-probe.mjs`，上游 `fake-llm.mjs`，**零模型调用**）：

  | 观测项 | 改前（scrollIntoView smooth） | 改后（scrollTop + rAF） |
  |---|---|---|
  | 贴底滞后 | max **778px**，126 帧里 **100 帧**滞后 >80px（一直在追） | max **44px**，滞后 >80px 的帧 **0** |
  | 方向反转 | 0 | 0 |
  | JS 层写入 | 走原生补间动画，脚本层 0 次赋值 | **118 次**，`maxWritesPerFrame = 1`（每帧最多一次） |
  | 用户上翻 500px | 仍被继续滚动（0 → 39）；滚回底部时 top 1539 而 bottom 2190，**差 651px 没跟上** | 写入 **0 次**、位置停在 440 不动；回到底部后 top == bottom == 2178，追滚恢复 |
  | 生成途中切会话再切回 | top **25** / bottom 3118，**没落到该会话底部** | top **3084** == bottom 3084，正好落底 |
  | 函数调用参数静默窗口（3s） | — | 写入 **0 次** |

  `pnpm build` 绿（936.36 kB / gzip 304.68），`lint` 仅 1 条既有告警（`Sidebar.tsx:155` exhaustive-deps）。

### 实测顺带抓到的缺陷：追滚在 StrictMode 下整个失效
第一版实现里 cleanup 只 `cancelAnimationFrame(id)`，没把 `frameRef.current` 置空。dev 下 React StrictMode 会把 effect 跑成 setup → cleanup → setup，第二次 setup 之后每次追滚都被 `frameRef.current !== null` 的守卫早退 —— **生产构建不复现（StrictMode 不双跑），单测也不复现（测的是纯逻辑函数，没经过组件）**，只有浏览器实测抓到：思考文字把列表撑到 1526px，`scrollTop` 全程 0、写入 0 次。

修法：cleanup 里取消之后一并 `frameRef.current = null`（"已取消"就等于"无待办帧"，这条不变量就地写进注释）。

- [x] 待办标记与 rAF 句柄同生同灭：取消即置空，否则 StrictMode 双跑会把追滚永久锁死
