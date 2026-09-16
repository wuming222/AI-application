# 聊天记录 Markdown 渲染支持 - SDD

## 需求
当前聊天界面中的消息内容以纯文本形式显示，无法渲染 Markdown 格式（如加粗、列表、代码块等）。需要集成 react-markdown 库，使 AI 返回的 Markdown 格式消息能够正确渲染，提升阅读体验。

## 实现步骤

### 1. 安装依赖
```bash
cd packages/web
pnpm add react-markdown
```

### 2. 修改 MessageList 组件
- 文件：`packages/web/src/components/MessageList.tsx`
- 导入 `ReactMarkdown` 组件
- 将消息内容从纯文本 `<div>` 改为 `<ReactMarkdown>` 渲染
- 保留原有的样式类名和布局

### 3. 添加 Markdown 样式支持
- 文件：可能需要新增或修改 CSS 文件
- 确保 Markdown 元素（h1-h6, ul, ol, code, pre, blockquote 等）的样式与 Ant Design 主题协调
- 代码块添加适当的背景和边框样式

### 4. 测试常见 Markdown 语法
验证以下语法能正确渲染：
- 标题（# ## ###）
- 加粗（**text**）和斜体（*text*）
- 无序列表和有序列表
- 代码块（```language ... ```）和内联代码（`code`）
- 引用块（> quote）
- 链接（[text](url)）

## 验收标准
- [ ] 安装 react-markdown 依赖成功
- [ ] MessageList 组件中使用 ReactMarkdown 渲染消息内容
- [ ] Markdown 格式的 AI 回复能正确显示样式
- [ ] 代码块有清晰的视觉区分
- [ ] 列表、标题、加粗等基础语法渲染正常
- [ ] 不影响现有纯文本消息的显示
