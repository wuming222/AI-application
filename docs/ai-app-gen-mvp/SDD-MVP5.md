# 慧应用 MVP-5：两阶段上下文截断 - SDD

## 需求

当前 `runAgentLoop` 每轮把全量 `Message[]` 发给 LLM。一个待办应用 index.html 约 7K 字符（写入参数 + 工具结果里各出现一次），迭代三四轮就会逼近上下文上限；20 轮循环上限形同虚设。MVP-5 按设计文档第六章实现两阶段截断，让长对话可控；附带 reasoning 折叠面板（qwen3.7-flash 每轮都有思考过程，目前被丢弃，无法在 UI 看到）。

**只做**：contextBudget 纯函数截断模块 + 单测、runAgentLoop 每轮组装、workspace 文件清单注入 system、read_file 输出预截断、StreamChunk 带 reasoning + AgentProgress 折叠展示。**不做**：LLM 摘要（原方案阶段一第 3 步）、token 精确分词器、持久化/会话管理、错误回传自愈。

## 关键设计决策

### 截断单位：分组（group），天然解决配对保护

消息流按角色切分为原子组，截断只作用于整组：

```
system | user | assistant(纯文本) | tool-round(assistant+tool_calls + 其后所有 tool 消息) | user | ...
```

- tool-round 通过 call_id 配对：assistant.tool_calls 里的每个 id 必须有对应 `role:'tool'` 消息，反之亦然
- 设计文档 12.1 的"悬空 tool_result / 留 tool_use 引发重复调用"两类事故在结构上不可能发生
- 单条超大 user 消息超过硬限：保留不切（宁可溢出不破坏语义），记录告警

### 阶段一：语义压缩（软限 60K token）

触发：每轮调 LLM 前，估算总 token > 软限。token 估算按设计文档：`1 token ≈ 3 字符`。

处理：保留 system + 首条 user（锚定意图）+ 最近 2 组完整不动；中间部分的 tool-round 压缩为单条 assistant 占位文本：

```
（历史第 N~M 轮工具调用已压缩：write_file(index.html)、read_file(index.html)。
文件内容已存于工作区，需要时用 read_file 获取。）
```

**与原方案的偏差**：文档用 LLM 对中间纯文本做摘要（摘要超 4000 token 还要砍到 2000）。MVP-5 改用确定性占位符——零额外 API 调用、零延迟、结果可预测，压缩率同样接近 100%（中间轮的大头本来就是文件内容）；且工作区文件清单会注入 system（见下），模型不会因压缩丢失"有哪些文件"的全局感知。LLM 摘要列为后续增强。

### 阶段二：硬截断（硬限 150K token）

阶段一之后仍超硬限时兜底：保留 system + 首条 user + 从尾部倒序贪心收集完整组，累计达硬限即停，中间整组丢弃。放在 Agent 主循环每轮发送前，作为最终防线。

### workspace 文件清单注入

system 提示词每轮重建，末尾追加当前文件清单（路径 + 字符数），不注入内容。这是阶段一占位符承诺"需要时用 read_file 获取"的前提——文件列表永远新鲜，被压缩的历史随时可按需重读。

### read_file 预截断（源头控制单条大小）

设计文档 12.1：一条大 tool_result 就能触发硬截断。read_file 输出上限 8000 字符，超出部分截断并注明 `[已截断，共 N 字符]`。写文件走 write_file 的参数（工作区已有全文），历史里无需保留。

### reasoning 折叠面板（对话流内）

- `StreamChunk` 增加 `reasoning?: string`；responses.ts 对 `response.reasoning_text.delta` yield reasoning（不再直接丢弃）
- `AgentProgressStep` 增加 `reasoningText`；runAgentLoop 累加
- 流式期间：实时进度块（含各轮思考过程、工具执行状态）作为对话流内最后一个助手气泡，由 MessageList 渲染在消息末尾，随对话滚动——不挂在输入栏上方
- 结束后：最终回复单独成气泡，思考过程（`Message.reasoning`）在气泡内可展开回看。一次任务的多轮工具调用在 MessageList 渲染层合并为一个气泡：一级头部显式执行次数（"🔧 执行工具 N 次"，可折叠、默认展开），二级为每个工具的可折叠行，展开即该工具的执行过程（入参 + 结果，长文本截断展示）；工具气泡内不单独展示模型思考。所有展开内容限高 220px 内部滚动，展开时 scrollIntoView(nearest) 保持点击行在视野内——避免在对话底部展开时列表被大幅顶起。store 消息结构保持 LLM 原始历史不变，分组只发生在渲染层
- `Message.reasoning` 仅用于展示：`toResponsesInput` 显式构造请求项，不会把该字段发给 LLM

### 截断只影响 LLM payload

`chatStore` 里的 messages 永远是全量（展示与后续轮次的历史事实），截断发生在 runAgentLoop 每轮构造发送 payload 时：`streamChat(truncateMessages(allMessages))`。触发截断时 `console.info` 输出前后 token 数，便于观察与调试。

## 实现步骤

1. `agent/contextBudget.ts`：estimateTokens + truncateMessages 两阶段 + 分组逻辑（纯函数，限值可注入）
2. `contextBudget.test.ts`：Vitest——配对保护、锚定保留、阶段一占位、阶段二贪心、超大单条
3. `runAgentLoop.ts`：每轮 payload 截断 + system 注入文件清单
4. `toolRegistry.ts`：read_file 8000 字符上限
5. `llm/types.ts` + `providers/responses.ts`：StreamChunk.reasoning；`agent/types.ts` + `AgentProgress.tsx`：折叠面板
6. `.env`：`VITE_CONTEXT_SOFT_LIMIT=60000` / `VITE_CONTEXT_HARD_LIMIT=150000`（代码内同值默认）

## 验收标准

- [x] Vitest 全过：tool 配对绝不被拆开；锚定消息任何阶段都保留；阶段一/二独立生效（12/12）
- [x] 调低软限跑 E2E：多轮迭代触发阶段一压缩，console 可见 token 前后对比，模型仍能基于文件清单继续迭代（不丢工作区感知）
- [x] 常规软限下正常流程无截断发生，回归通过（生成/迭代/中止）
- [x] reasoning 折叠面板在思考轮次可展开查看，默认收起
- [x] read_file 大文件输出被截断到 8000 字符内
- [x] 类型检查通过

## 联调发现与修复

E2E 期间（softLimit 调至 800 触发压缩）发现三个问题，均已修复并回归验证：

### 1. chatStore 过滤器拆散 tool 配对（严重）

`chatStore.sendMessage` 原来以 `messages.filter((m) => m.content !== '')` 组装历史——content 为空的 assistant 消息（即工具调用轮）被整体丢弃，但其 `role:'tool'` 结果消息保留下来成为孤儿。后果：下一次调用发给 DashScope 的是"没有 function_call 的 function_call_output"（`call_id` 无从配对），本次碰巧被上游容忍，但属于未定义行为；同时阶段一压缩只能压到这些孤儿小消息，真正的大头（write_file 参数里的完整文件内容）已经不在上下文里，压缩形同虚设。

修复：移除该过滤器。空 content 的 assistant 消息由 provider 层 `toResponsesInput` 正确转换（跳过 content、保留 function_call 项），配对天然完整。修复后压缩日志变为真实收缩：`1779 → 225`、`5587 → 4033`、`6730 → 2337`。

### 2. AgentProgress 快照 bug：进度面板从不更新（中等）

`runAgentLoop` 原来 `steps.push({ ...step })` 推入快照拷贝，之后对 `step` 的所有变更（thinkingText / reasoningText / toolCalls 状态 / status）都发生在原对象上，面板永远停在"第 N 轮思考中"。这意味着 MVP-3 引入的"工具执行状态实时显示"实际从未生效，MVP-5 的 reasoning 折叠面板也受同一 bug 影响而不渲染。

修复：`steps.push(step)` 推入同一引用（`emitProgress` 每次用新数组触发渲染，元素引用稳定无害）。修复后面板实时显示"第 N 轮执行工具 ✓ read_file (index.html)"与各轮"思考过程"折叠面板。

### 3. 阶段一压缩可能"负压缩"（轻微）

占位符文本（约 19 token）可能大于被压缩的小组（如孤儿 tool 输出约 7 token），压缩后上下文反而变大（实测 `1689 → 1696`）。修复：压缩前比较 `estimateTokens(占位符) < groupTokens(原组)`，无收益则保留原组。

### 4. 模型偶发空响应（外部，未复现）

一次 E2E 中 round-2 返回 reasoning-only 空文本导致循环提前结束。用完全一致的 payload 通过本地 proxy 复现请求：`FINAL_STATUS=completed`、正常输出 183 字符——确认非 payload/代理/输出上限问题，属上游模型偶发行为，无法复现。已在 responses.ts 增加空响应诊断日志（区分"流正常结束但无文本"与"流提前中断"，附 status / incomplete_details），便于日后观察。
