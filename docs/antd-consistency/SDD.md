# 统一到 Ant Design 组件 - SDD

## 需求
项目已引 antd，但仍有 6 处裸 `<button>`、大量 inline style，`title` 属性当提示用，没吃到组件库能力。本轮只做已确认的 **P0 + P1**：先把样式归属与 token 的规矩定下来，再换掉最明显的控件。P2（全量色值换 token）、P3（布局收进 Flex/Layout）不在本轮。

顺序有讲究：antd 组件自带 CSS-in-JS 样式，留着 inline style 去套组件会踩优先级覆盖 —— 本轮之前的 `.dragging` 被同节点 inline `background` 盖掉就是同一个坑。所以 P0 先立规矩，P1 才动控件。

## 实现步骤

### 1. P0：把约定写进 `AGENTS.md` 的「编码约束」
- 状态/布局样式归同名 `.css` 的 class；JSX 的 `style` 只允许放**真正运行时才知道值**的东西（transform、动态宽高）
- 色值、圆角、间距取 antd token（`theme.useToken()`），不写死十六进制 —— `main.tsx` 已配 `colorPrimary` 与跟随系统的 `darkAlgorithm`，写死的颜色在深色模式下会和 antd 表面打架
- 能用 antd 组件表达的交互不手写：分段切换用 `Segmented`、提示用 `Tooltip`，不用 `title` 属性
- 有意例外要就地注明理由，不悄悄留裸标签

### 2. 预览/代码切换 → `Segmented`
- 文件：`packages/web/src/components/PreviewArea.tsx`
- 两个裸 `<button>`（`:55`、`:62`）换成一个 `<Segmented options={VIEW_OPTIONS} value={view} onChange={...} />`
- `VIEW_OPTIONS` 用 `{ label, value: PreviewView }[]` 定义，避免字符串比较与 `as` 散落
- 删除 `PreviewArea.css` 里的 `.preview-tabs`、`.preview-tab`、`.preview-tab:hover`、`.preview-tab.active` 四段手写样式

### 3. 刷新 / 下载 → 图标化 `Button`
- 文件：`PreviewArea.tsx`（`:72`、`:76`）
- 换成 antd `Button`（默认带边框）+ 图标（`ReloadOutlined` / `DownloadOutlined`），**默认尺寸**以与左侧 `Segmented` 的 32px 高度对齐；说明文字移到 `Tooltip`；保留 `disabled={srcdoc === null}`
- 不用文字按钮的理由：antd 会给两字中文标签自动插一个字距，渲染成「刷 新」「下 载」
- 不保留 `type="text"` 的理由：图标色本来就已经是最深的 `colorText`（`rgba(0,0,0,0.88)`），显淡不是颜色浅，而是**完全没有边框与底色**、控件轮廓不存在，加上 24px 在 32px 的 Segmented 旁边显小
- 刷新仍只在预览视图显示；`downloadIndex` 逻辑不动
- 删掉 `.preview-actions button` 这条为裸按钮写的补丁样式

### 4. `title` → `Tooltip`
- 文件：`packages/web/src/components/Sidebar.tsx`
- 「新建会话」「收起侧边栏」两个按钮的 `title="…"` 换成 `<Tooltip title="…">` 包裹
- 折叠态那个新建按钮原本没有任何提示，补一个 `Tooltip`

### 5. 两个有意保留的原生按钮
- `PreviewArea.tsx:107` 文件列表行：只在 >1 文件时出现。antd 对应物是 `Menu`，但 `Menu` 自带缩进/动画/内边距，而本机没有多文件会话数据、无法做视觉验证 → 保留原生 `button`，就地注明理由
- `ChatInterface.tsx:84` 图片移除角标：18px 圆形浮标不是 `Button` 的形态。保留原生，但**把它那串 inline style 移进 `ChatInterface.css` 的 `.image-remove` class**（这属于 P0 规矩的范围内，不是 P3 大改）
- 需要新建 `packages/web/src/components/ChatInterface.css`（该组件目前同名样式文件都没有）

## 验收标准
- [x] `grep -rn "<button" packages/web/src` 只剩 2 处（`ChatInterface.tsx:86`、`PreviewArea.tsx:101`），两处都有就近注释说明保留理由
- [x] 预览/代码切换由 `Segmented` 承担，切换行为与之前一致（实测来回切 iframe 仍是同一 DOM 节点，代码视图 534 个高亮 span 正常）
- [x] 刷新、下载是 antd 默认带边框的图标按钮，实测 32×32 与左侧 `Segmented` 同高；Tooltip 给出说明；点击下载仍产出 8944 字节的 Blob；无产物时为禁用态；代码视图下只剩下载、刷新按预期隐藏
- [x] Sidebar 新建/收起按钮出现 antd Tooltip（实测 `.ant-tooltip` 渲染出；原生 `title` 属性已不存在）
- [ ] 图片移除角标外观与改前一致，点击仍能移除 —— 需要真实上传文件才会渲染出角标，未实测（仅确认样式值逐条搬进 `.image-remove`，未改动数值）
- [x] 手写 `.preview-tab*` 与 `.preview-actions button` 样式已删，无死规则
- [x] 浏览器实测无明显尺寸回归：header 高 45px、Segmented 32×104px，在 280px 宽面板内不溢出
- [x] `pnpm --filter web test:run` 25/25 通过；`npx tsc -b` 不新增错误

## 附带发现
antd `Button` 对两字中文标签会自动插入一个字距（渲染为「刷 新」「下 载」），是组件库既定行为，非 bug。
