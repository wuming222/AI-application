# 空会话下点「新建会话」不应再创建一个 - SDD

## 需求
已经停在一条空的「新对话」上时再点新建，列表会再多出一条空的「新对话」，连点会堆出好几条一模一样的会话。

实测复现：会话数 7（含 3 条空「新对话」）连点两次 → 9 条，顶部连着两条空会话。根因是 `packages/web/src/store/sessionStore.ts:63` 的 `createSession` 无条件 `POST /api/sessions`，`Sidebar.tsx` 的新建按钮直接调它，中间没有"当前会话本来就是空的，复用它"这一步。

期望：当前会话还没有任何内容时，点新建等于回到干净输入框；只有已有内容时才真的新建。

## 实现步骤

### 1. 在 sessionStore 加一个薄动作
- 文件：`packages/web/src/store/sessionStore.ts`
- 新增 `createOrReuseSession: () => Promise<string>`，`SessionState` 接口同步补类型
- 逻辑：
  - 取 `currentSessionId`、`useChatStore.getState().messages.length`、`useWorkspaceStore.getState().getCurrentFiles()` 的键数
  - 三者满足「有当前会话 且 消息数为 0 且 无生成文件」→ 直接返回 `currentSessionId`，不发请求
  - 否则 `return createSession()`
- 判断放 store 而不是按钮里：两处新建入口（展开态头部按钮、折叠态按钮）都要同一个语义，且折叠态那个按钮没有 disabled 之类差异化逻辑
- `createSession` 保持原样不动：它仍表示"无条件新建"，`initFirstSession` 依赖这个语义（首次启动时确实要建一条）

### 2. 两个新建入口改调新动作
- 文件：`packages/web/src/components/Sidebar.tsx`
- 展开态与折叠态的「新建会话」按钮 `onClick` 改为 `createOrReuseSession()`

### 3. 复用时要给可感知的反馈
- 复用时列表没有任何变化，用户会觉得"点了没反应"，所以把光标送到输入框
- 文件：`packages/web/src/store/chatStore.ts`
  - 加 `composerFocusTick: number`（初值 0）与 `requestComposerFocus: () => void`（自增）
  - 复用分支里由 `createOrReuseSession` 调用它
- 文件：`packages/web/src/components/ChatInterface.tsx`
  - `useEffect` 监听 `composerFocusTick`，对 TextArea 已有的 `inputRef`（`ChatInterface.tsx:99`）调用 `focus()`
  - 不查 DOM id、不用 `document.querySelector`

### 4. 边界
- 没有当前会话（`currentSessionId === null`，例如最后一条被删光之后）→ 走新建
- 会话已被重命名但仍然没有消息也没有文件 → 仍然复用（"空"只看内容，不看标题）。这条要有测试意识：标题不是判据
- 正在流式输出时点新建：此时消息数已 ≥ 1（`sendMessage` 先落用户消息），走新建分支，行为与现状一致，不额外处理

## 验收标准
- [ ] 停在空「新对话」上连点 3 次新建，会话总数不变
- [ ] 复用时光标落到输入框，输入框可用
- [ ] 当前会话已有消息时点新建，正常创建并切到新会话
- [ ] 当前会话只有生成文件、没有消息时点新建，正常创建（文件也算内容）
- [ ] 最后一条会话被删除、无当前会话时点新建，正常创建
- [ ] 首屏自动建会话的行为不变（`initFirstSession` 仍能建出第一条）
- [ ] 不新增任何后端请求：复用路径下 network 里看不到 `POST /api/sessions`
- [ ] `pnpm --filter web test:run` 通过
