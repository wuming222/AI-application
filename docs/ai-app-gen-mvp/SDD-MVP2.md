# MVP-2：Agent Loop（无工具） - SDD

## 需求

MVP-0/1 只实现了单次对话闭环（用户发消息 → LLM 回复）。MVP-2 补上**智能体多轮自主思考能力**：模型可以连续输出多轮文本，直到任务完成，无需用户逐条追问。这是后续接入工具执行的地基——先跑通循环逻辑，再挂工具。

**只做**：
- `packages/web/src/agent/runAgentLoop` — Agent 主循环（最多 200 轮），每轮：组装上下文 → 调 LLM → 判断是否继续 → 累积文本
- `packages/web/src/store/chatStore` 改造 — sendMessage 触发 runAgentLoop，支持多轮自动循环
- `packages/web/src/components/AgentProgress` — 进度面板组件，实时显示思考状态
- **不做任何工具执行**（fs / MCP / BaaS / use_skill 全部留给 MVP-3）

**不做**：
- 虚拟文件系统、工具集、toolCalls 解析（MVP-3）
- plan/build 分级模式（MVP-3）
- 上下文截断（60K 软压缩 / 150K 硬截断，MVP-3）
- iframe srcdoc 预览（UI 已有 MessageList）
- 图片上传、语音输入（纯文本）
- provider 重试机制（直接报错提示用户）

前端代码全部在 `packages/web`，server 包不动（LLM proxy 已够用）。

## 实现步骤

### 阶段 0：类型定义 `packages/web/src/agent/types.ts`

```typescript
// AgentLoopOptions
export interface AgentLoopOptions {
  maxRounds?: number    // 默认 200
  onProgress?: (progress: AgentProgress) => void
  signal?: AbortSignal
}

// AgentProgress — 累加式快照数组
export interface AgentProgress {
  steps: AgentProgressStep[]
  finished: boolean
  startAt: number
}

export interface AgentProgressStep {
  thinkingText: string
  status: 'thinking' | 'done'
}
```

### 阶段 1：Agent 主循环 `packages/web/src/agent/runAgentLoop.ts`

```typescript
export async function runAgentLoop(
  messages: Message[],
  options?: AgentLoopOptions,
): Promise<{ finalText: string; updatedMessages: Message[] }>
```

**四阶段循环（最多 maxRounds 轮）：**

1. **构造与调用**
   - 拼接 messages 历史（MVP-2 不做 system prompt 增强，直接用现有消息）
   - 调 `streamChat(messages, signal)` 获取流式响应
   - emit `thinking` 进度事件

2. **提取与判断**
   - 累积 text 内容
   - **MVP-2 简化终止条件**：当前端检测到模型输出包含特定结束标记（如 "任务已完成" 或连续两轮无新内容）时停止；或者简单起见，固定跑 N 轮（如 3 轮）后停止
   - 更务实的做法：MVP-2 只做**固定轮数循环**（如 3 轮），每轮把上一轮的 assistant 回复作为新的 user 消息追加，模拟"自我追问"

3. **回填**
   - 每轮的 assistant 回复追加到 messages
   - 回到步骤 1 开启下一轮

**MVP-2 简化策略（推荐）：**
- 固定 3 轮循环，不做 toolCalls 判断
- 第 1 轮：用户消息 → LLM 回复
- 第 2 轮：把第 1 轮回复作为"请继续完善"的隐式指令 → LLM 补充
- 第 3 轮：同上 → LLM 最终总结
- 这样无需解析 toolCalls，也无需虚拟 FS，但能验证循环框架

**终止条件（任一满足即停）：**
- 达到 maxRounds（默认 3，MVP-2 先用小数字验证）
- signal.aborted（用户取消）

**进度上报：**
- 每轮 emit 浅拷贝新对象到 `onProgress`
- 累加式 steps 数组，不 mutate 旧对象

### 阶段 2：chatStore 改造 `packages/web/src/store/chatStore.ts`

- `sendMessage(text)` 改为：
  1. 追加 user 消息
  2. 创建空 assistant 消息占位
  3. 调 `runAgentLoop(messages, { onProgress, signal })`
  4. 逐轮更新 assistant content（text 累积）
  5. 循环结束后标记 isStreaming = false

- 新增 `abort()` — 调 AbortController.abort()，中断当前循环

### 阶段 3：AgentProgress 组件 `packages/web/src/components/AgentProgress.tsx`

- 接收 `progress: AgentProgress` prop
- 渲染步骤列表：
  - `thinking` → 显示 "第 N 轮思考中..." + thinkingText
  - `done` → 显示 "✓ 第 N 轮完成"
- finished 时显示 "生成完成"
- 自动滚动到底部

### 阶段 4：App.tsx 组合

- 引入 AgentProgress 组件
- 布局：header + MessageList + AgentProgress（仅 streaming 时显示）+ ChatInterface

### 阶段 5：验收

- 发一条消息 "帮我写一个待办事项页面的方案"，看到 3 轮循环：
  - 第 1 轮：LLM 输出初步方案
  - 第 2 轮：LLM 补充细节
  - 第 3 轮：LLM 最终总结
- AgentProgress 实时显示每轮的思考状态
- 点"停止"按钮能中断循环
- Mock provider 模式下也能跑通

## 验收标准

- [ ] `pnpm --filter web dev` 后发送消息，看到 3 轮自动循环输出
- [ ] AgentProgress 面板实时显示每轮的 thinking / done 状态
- [ ] 流式传输中点"停止"，循环立即中断，UI 不再追加内容
- [ ] Mock provider 模式下也能跑通（无需真实 LLM）
- [ ] `pnpm --filter web test` 全绿（至少覆盖：runAgentLoop 固定轮数循环、abort 信号传播）
- [ ] 构建产物 grep 确认无 API key
