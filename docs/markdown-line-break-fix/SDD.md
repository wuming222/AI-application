# AI 消息 Markdown 换行过多 - SDD

## 需求
AI 消息渲染后空白行过多，长回答读起来很松散。

实测根因（在跑着的 dev 页面上用 DOM 探针确认）：消息气泡 inline style 带 `whiteSpace: 'pre-wrap'`，该属性继承进 `.message-markdown`。react-markdown 会在段落内的软换行处输出**只含 `\n` 的裸文本节点**，`pre-wrap` 把每一个都渲染成真实换行；而 Markdown 本身又已经按块级结构排好了版，于是换行叠加。取样气泡统计：4 个 `<p>` 里混有 10 个裸 `\n` 文本节点。

因此不能只是简单关掉 `pre-wrap`（那样模型用单换行写的多行内容会挤成一行），需要「关掉继承的 pre-wrap + 让单个 `\n` 正规地渲染成一个 `<br>`」。

## 实现步骤

### 1. 让 Markdown 容器不再继承 pre-wrap
- 文件：`packages/web/src/components/MessageList.css`
- 新增规则：`.message-markdown { white-space: normal; }`
- 段落/列表间距继续由已有的 `p`、`li` margin 控制，不额外加 margin

### 2. 单换行按 `<br>` 渲染
- 文件：`packages/web/src/components/MessageList.tsx`
- 引入 `remark-breaks`，`<ReactMarkdown remarkPlugins={[remarkBreaks]}>`
- 这样源码里的单个 `\n` → 一个 `<br>`；空行分段仍走 `<p>`，不再重复产生换行

### 3. 依赖
- 命令：`pnpm --filter web add remark-breaks`
- `pnpm-lock.yaml` 随之更新，需要一并提交

### 4. 不能改坏的地方
- `ToolGroupBubble`（`MessageList.tsx` 内的工具执行气泡）渲染的是**原始文本**、不走 Markdown，它的 `whiteSpace: 'pre-wrap'` 必须保留
- 用户消息气泡同样走 ReactMarkdown，与 AI 消息共用 `.message-markdown` 规则，改完两边都要看一眼
- `<pre>` 代码块自带 `pre` 语义，不受容器 `normal` 影响

## 验收标准
- [ ] `.message-markdown` 计算样式为 `white-space: normal`
- [ ] 同一条 AI 消息渲染后，段落数与源码空行数一致，且段落内不再出现由裸 `\n` 造成的额外空行
- [ ] 模型用单换行写的多行内容仍然逐行显示（每行一行，不挤成一段）
- [ ] 工具执行气泡的换行与改前一致（`white-space` 仍为 `pre-wrap`）
- [ ] 代码块、列表、标题、表格渲染无回归
- [ ] `pnpm --filter web test:run` 通过
