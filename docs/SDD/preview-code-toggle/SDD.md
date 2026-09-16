# 预览 / 代码切换（顺带产物下载） - SDD

## 需求
右侧现在只有 iframe 预览，看不到 agent 写了哪些文件、文件里是什么内容，也没法把产物带走。在 `PreviewArea` 头部加「预览 / 代码」切换：代码视图列出当前会话 workspace 的文件并可点开查看只读内容；同时提供下载，把 `buildSrcdoc` 内联出来的 `index.html` 存到本地。

定位是"摊开 + 带走"：摊开解决"生成不对时能定位是哪个文件"，带走解决"产物只能待在 iframe 里"。

## 实现步骤

### 1. tab 状态与不丢预览
- 文件：`packages/web/src/components/PreviewArea.tsx`
- 加 `const [view, setView] = useState<'preview' | 'code'>('preview')`
- iframe **始终挂载**，切到代码视图时用外层容器的 `display: none` 隐藏，不用条件渲染 —— 条件渲染会让 iframe 重新加载，预览里生成的应用内部状态就丢了
- 现有"刷新"按钮（`manualKey`）保持只作用于预览视图

### 2. 代码视图
- 文件列表：`Object.keys(files).sort()`，每项显示路径与 `content.length` 字节数
- 选中项：`const [selectedPath, setSelectedPath] = useState<string | null>(null)`
  - 默认选中 `index.html`，没有则取排序后的第一个
  - `files` 变化时（新一轮生成、切会话）：若选中文件已被删除，回落到默认项
- 内容区：`<pre>` 只读展示，沿用项目里的等宽字体写法（见 `MessageList.css` 的 `code` 规则）
- 超大文件保护：超过约 200k 字符时只渲染前 200k 并给出"文件较大，仅展示前 … 字符，下载查看完整内容"的提示，避免整个 DOM 卡死

### 3. 下载
- 复用已经算好的 `srcdoc`（`buildSrcdoc(files)` 的产物），不另起拼装逻辑
- `new Blob([srcdoc], { type: 'text/html' })` + `URL.createObjectURL` + 临时 `<a download="index.html">` 触发，之后 `revokeObjectURL`
- `srcdoc === null`（还没生成 index.html）时按钮禁用
- 位置：放在头部右侧与"刷新"并列；代码视图下才显示"刷新"以外也不别扭，两个视图都可见即可

### 4. 空态
- `files` 为空时，代码视图显示"还没有生成文件"，不渲染空列表
- 预览视图保持现有文案"生成 index.html 后可预览"

### 5. 明确不做
- 代码视图只读，不提供编辑：手改会与下一轮 `write_file` 冲突，需要覆盖规则，另议
- 不做 zip 多文件打包（`index.html` 已内联全部资源，单文件即可带走）

## 同日调整

### 去掉文件大小展示
列表项只显示路径，`字符` 数对读代码没有价值。

### 加语法高亮（推翻原"不引入高亮依赖"）
原方案为省体积不引高亮，实测裸文本可读性不够，改为引入 **highlight.js**：

- 依赖：`pnpm --filter web add highlight.js`；只用 `highlight.js/lib/common` 子集（含 html/css/js/ts/json/markdown 等常用语言），不是全量 190 种语言
- 主题：`highlight.js/styles/github.css`；我们的 `<code>` 上没有 `.hljs` 类，所以主题的 padding/背景不会干扰布局，只有 `hljs-*` token 类的配色生效
- 高亮逻辑抽到 `packages/web/src/preview/highlight.ts`，按扩展名映射语言；认不出语言时退回转义后的纯文本
- 结果用 `useMemo` 缓存，只在选中文件/内容变化时重算（高亮是同步的，大文件会卡主线程）

**安全边界**：渲染走 `dangerouslySetInnerHTML`，安全性完全依赖 hljs 会把代码正文转义、输出里只有它自己生成的 `hljs-*` span。这一点由 `src/preview/__tests__/highlight.test.ts` 锁住（断言恶意 `<img>` / `<script>` 不会以裸标签形式出现在三种语言的输出里）。若以后换/升级高亮库，这个测试是第一道防线。

## 验收标准
- [x] 头部可在「预览 / 代码」之间切换
- [x] 切到代码再切回预览，iframe 里生成的应用不会重新加载（实测 iframe 为同一个 DOM 节点，探测属性仍在其上）
- [x] 代码视图列出当前会话全部文件（只显示路径），可点选查看内容（实测 `index.html`）
- [x] 代码内容按扩展名做语法高亮，token 有配色（实测 534 个 `hljs-*` span、8 类 token）
- [x] 只读：界面里没有任何修改文件内容的入口（实测代码面板内 input/textarea/contenteditable 数为 0）
- [x] 切换会话时文件列表与选中项跟着变（实测 5 条会话分别为 0/0/0/1/1 个文件）
- [x] 无文件时显示空态提示（"还没有生成文件"）
- [x] 点击下载能得到 `index.html`，且内容与 iframe 中看到的一致（实测 Blob 文本与 `srcdoc` 逐字符相等，均 8926 字符）
- [x] 未生成 index.html 时下载按钮禁用
- [ ] 超大文件截断展示 —— 阈值 200k 字符已实现，但没有真实大文件可跑，仅代码层确认
- [x] `pnpm --filter web test:run` 通过（12/12）
