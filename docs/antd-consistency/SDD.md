# 统一到 Ant Design 组件 - SDD

## 需求
项目已引 antd，但仍有 6 处裸 `<button>`、大量 inline style，`title` 属性当提示用，没吃到组件库能力。

先做 **P0 + P1**（定规矩 + 换掉最明显的控件），随后按用户要求把 **P2**（色值/圆角全量换 token）与 **P3**（布局与状态样式收进 class）一并做完 —— 见文末「P2 + P3 追加执行」。

顺序有讲究：antd 组件自带 CSS-in-JS 样式，留着 inline style 去套组件会踩优先级覆盖 —— 本轮之前的 `.dragging` 被同节点 inline `background` 盖掉就是同一个坑。所以 P0 先立规矩，P1 换控件，最后才做 P2/P3 的全量收敛。

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

## P2 + P3 追加执行

### 先纠正一个错误前提
P2 原计划直接用 `var(--ant-color-text)`，前提是"antd v6 已开启 cssVar"。**这个前提是错的**：实测在 `.session-item` 上 `getComputedStyle().getPropertyValue('--ant-color-text')` 全部返回空。之前的探针之所以看着能用，是因为给元素塞了一个未定义变量，声明被丢弃后 `color` 回落到继承值，看起来正好等于按钮自己的颜色。

### 实际机制：App 根节点桥一层自有变量
`App.tsx` 里 `useThemeVars()` 用 `theme.useToken()` 取 token，写成 `--app-text`、`--app-bg-layout`、`--app-radius-lg` 等挂在根 div 上，各组件同名 `.css` 用 `var(--app-*)` 取。值仍然源自 antd token，因此跟着 `ConfigProvider` 的主题与 `darkAlgorithm` 走。

例外（保留字面值，已在 CSS 顶部注明）：阴影，以及叠在特定底色上的半透明白/黑（用户气泡内部那些 `rgba(255,255,255,.x)`）。antd 的 `boxShadow*` 明显更弱，替换会造成可见回归。

### P2 的色值位移表
| 原值 | 换成 token | 计算值变化 |
|---|---|---|
| `#333` | `colorText` | `rgb(51,51,51)` → `rgba(0,0,0,.88)` |
| `#666` | `colorTextSecondary` | `rgb(102,102,102)` → `rgba(0,0,0,.65)` |
| `#999` | `colorTextTertiary` | 153 → 0.45 黑 |
| `#e8e8e8` | `colorBorder` | 232 → 217 |
| `#f0f0f0` | `colorBorderSecondary` | **不变** |
| `#fafafa` | `colorBgLayout` | 250 → 245 |
| `#f5f5f5` | `colorBgLayout` | **不变** |
| `#fff` | `colorBgContainer` | **不变** |
| `#6b9fd4` | `colorPrimary` | **不变**（main.tsx 已如此配置） |
| `#ef4444` | `colorError` | → `#ff4d4f` |
| `#2ecc71` / `#f39c12` | `colorSuccess` / `colorWarning` | → antd 绿/橙 |
| `#4a9eff` | `colorPrimary`（spinner）/`colorInfo`（reasoning 条） | 蓝调统一进主题 |
| 圆角 `6` / `8` | `borderRadius` / `borderRadiusLG` | **不变**（配置即 6，默认 8） |
| 气泡圆角 `12/16/18/20` | 保留字面 | 属于造型值，无对应 token |

### P3：收进 class，而不是换 Flex/Layout
`Space`/`Flex`/`Layout` 只是把 inline style 换成组件 props，运行时生成的还是同样的样式，既不减样式量也不解决"状态写不进 class"的问题。所以 P3 的做法是把布局与状态样式移到各组件同名 `.css`，JSX 只留真正动态的值。

结果：inline style 从 **56 处 → 3 处**（`sidebarWidth`、dnd-kit 的 `transform/transition`、聊天列拖拽宽度），组件 TSX 里已无写死色值。

顺带清掉的两处：
- `AgentProgress.css` 里媒体查询的 `!important` —— 它原本只是为了压过内联样式，样式进 class 后不再需要
- `ChatInterface.tsx` 里 JSX `<style>` 写的 `@keyframes pulse` —— 移进 `ChatInterface.css`

### 没有截图能力时怎么验证
in-app 浏览器视口隐藏，`take_screenshot` 不可用，所以改用**改前/改后计算样式对比**：改动前用 `getComputedStyle` + `getBoundingClientRect` 给 10 个关键元素（会话项激活/未激活、标题、侧栏容器、头部标题、两类气泡、markdown 段落、预览头部）打了基线，改完跑同一段探针比对。

结论：**几何零变化** —— padding、margin、font-size、font-weight、line-height、border-radius、阴影、元素尺寸全部逐项相等（如激活项 `10px 12px` / `8px` / 183×45，气泡 154×447 与 154×81，`md p` margin `6.4px 0`）；颜色只在上面那张表列出的项上按 token 位移。`.session-more` 的 `1 / 0` 透明度证明"按状态切 opacity"从内联改到 class 后行为不变。

### 过程中自己引入又修掉的两个问题
1. `.app-chat { flex: 1 }` —— `flex: 1` 展开是 `1 1 0%`，会**忽略**拖拽设定的 `width`，直接让聊天列改宽失效。已从 CSS 去掉，伸缩仍由内联动态 `flex` 控制。
2. 顺手修掉一个历史类型错误：`AgentProgress.tsx` 把 `tc.args.path`（`unknown`）当 ReactNode 用。按 AGENTS.md 的要求先收窄成 `string` 再用，`tsc` 的历史错误从 5 个降到 4 个。

### P2/P3 验收
- [x] 组件 TSX 里无写死十六进制色值（`grep` 为空），`style={{` 只剩 3 处动态值
- [x] 改前/改后计算样式对比：几何零变化，颜色仅按映射表位移
- [x] 聊天列拖拽改宽链路正常（`mousedown → mousemove → mouseup`，内联 `width` 更新、body 光标复位）
- [x] 预览 iframe 仍撑满面板（`.preview-frame` 实测 279×639），代码视图高亮 534 个 token span 正常
- [x] 深色模式：所有面/边框/文字色改走 `--app-*` 后不再残留浅灰底与深灰字（此前 `#333`/`#fafafa`/`#555` 在暗色表面上不可读）
- [x] `tsc` 4 个历史错误（较改动前少 1），无新增；`vitest` 25/25 通过
- [ ] 深色模式的实际观感未逐屏确认 —— 需要把系统切到 dark 再看一轮
