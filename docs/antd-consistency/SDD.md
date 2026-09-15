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

### 3. 刷新 / 下载 → 图标化 `Button`（最终采用 ③）
这一项反复了几轮，记录全过程：

| 轮次 | 形态 | 结果 |
|---|---|---|
| ① | `Button size="small"` + 文字 | 被否 —— 两字中文被 antd 自动插字距，渲染成「刷 新」「下 载」 |
| ② | `Button type="text"` + 图标 + Tooltip | 被否（"太淡"）。实测图标色已是最深的 `colorText(rgba(0,0,0,0.88))`，淡的原因是 `type="text"` 无边框无底色、控件没有轮廓 |
| ③ | `Button` 默认带边框 + 图标，默认尺寸对齐 Segmented 的 32px | **当前生效形态** |
| ④ | 回退成原生文字按钮 | 曾按要求做过，随后又撤回 ③ |

说明文字放 `Tooltip`（「重新加载预览」/「下载 index.html（资源已内联）」），比挤在按钮标签上更合适；`disabled={srcdoc === null}` 保持不变。刷新仍只在预览视图显示，`downloadIndex` 逻辑不动。

教训写进 `AGENTS.md`：antd 组件不是无条件更优，视觉取舍以实际效果为准，尤其注意 `Button` 的两字中文标签字距、以及 `type="text"` 缺少轮廓这两点。

### 4. `title` → `Tooltip`
- 文件：`packages/web/src/components/Sidebar.tsx`
- 「新建会话」「收起侧边栏」两个按钮的 `title="…"` 换成 `<Tooltip title="…">` 包裹
- 折叠态那个新建按钮原本没有任何提示，补一个 `Tooltip`

### 5. 两个有意保留的原生按钮
- `PreviewArea.tsx:107` 文件列表行：只在 >1 文件时出现。antd 对应物是 `Menu`，但 `Menu` 自带缩进/动画/内边距，而本机没有多文件会话数据、无法做视觉验证 → 保留原生 `button`，就地注明理由
- `ChatInterface.tsx:84` 图片移除角标：18px 圆形浮标不是 `Button` 的形态。保留原生，但**把它那串 inline style 移进 `ChatInterface.css` 的 `.image-remove` class**（这属于 P0 规矩的范围内，不是 P3 大改）
- 需要新建 `packages/web/src/components/ChatInterface.css`（该组件目前同名样式文件都没有）

## 验收标准
- [x] `grep -rn "<button" packages/web/src` 只剩 2 处（`ChatInterface.tsx:86` 角标、`PreviewArea.tsx` 文件列表行），都有就近注释说明保留理由
- [x] 预览/代码切换由 `Segmented` 承担，切换行为与之前一致（实测来回切 iframe 仍是同一 DOM 节点，代码视图 534 个高亮 span 正常）
- [x] 刷新、下载是 antd 默认带边框的图标按钮，实测 32×32 与左侧 `Segmented` 同高；Tooltip 给出说明；点击下载产出 8944 字节 Blob；无产物时禁用；代码视图下只剩下载
- [x] Sidebar 新建/收起按钮出现 antd Tooltip（实测 `.ant-tooltip` 渲染出；原生 `title` 属性已不存在）
- [ ] 图片移除角标外观与改前一致，点击仍能移除 —— 需要真实上传文件才会渲染出角标，未实测（仅确认样式值逐条搬进 `.image-remove`，未改动数值）
- [x] 手写的 `.preview-tabs` / `.preview-tab*` 与 `.preview-actions button` 样式均已删，无死规则
- [x] 浏览器实测无明显尺寸回归：header 高 45px、Segmented 32×104px，在 280px 宽面板内不溢出
- [x] `pnpm --filter web test:run` 25/25 通过；`npx tsc -b` 不新增错误

## 附带发现
antd `Button` 对两字中文标签会自动插入一个字距（渲染为「刷 新」「下 载」），是组件库既定行为，非 bug。
