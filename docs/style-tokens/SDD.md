# 样式集中：设计令牌层 - SDD

## 需求
样式值散落在 7 个 CSS 文件里，没有尺度体系：圆角 8 种取值、间距 8 档、字号 6 档含 13.5 半档，等宽字体与同类阴影各写多遍。这轮把"值"抽成一层设计令牌，组件只引用令牌。

已澄清的范围：只建令牌层（不引 CSS Modules/Tailwind、不做多主题）；一套语义化 scale；**允许把值对齐到档位**；一次性替换 + 改前/改后计算样式比对。

## 关键设计决定：两层，不能合成一层

| 层 | 位置 | 内容 | 为什么 |
|---|---|---|---|
| 静态尺度 | `src/styles/tokens.css`（`main.tsx` 里先于组件引入） | `--space-*`、`--radius-*`、`--font-*`、`--shadow-*`、`--motion-*`、`--font-mono` | 与主题无关，构建期定死 |
| 主题派生颜色 | `App.tsx` 的 `useThemeVars()` → `--app-*` | 文本/边框/填充/语义色 | 必须运行时从 `theme.useToken()` 取。antd v6 在这里不把 token 暴露成全局 `--ant-*`（实测组件节点取不到），且要跟随 `darkAlgorithm` |

原先 `--app-radius` / `--app-radius-lg` 混在颜色桥里，本轮删掉，圆角归静态层，避免同一值两套来源。

## 档位表（含被对齐的值）

**间距** `--space-1..5` = 4 / 8 / 12 / 16 / 32
- 6 → 8、10 → 12、2 → 4 ；40 → 32（空态内边距）；20 → 16（消息列表左右）
- 面板内统一内边距从 3 种（`10px 14px`、`10px 12px`、`12px 16px`）收敛成 2 种：气泡/进度块用 `--space-3 --space-4`，列表行用 `--space-2 --space-3`

**圆角** `--radius-xs|sm|lg|pill|full` = 4 / 8 / 12 / 18 / 999
- 1 → full（把手上的指示条）、3 → 4、6 → 8、16 → 18、20 → 18；8 / 12 / 18 原样保留

**字号** `--font-xs..xl` = 12 / 13 / 14 / 16 / 18
- 13.5 → 13、15 → 16；`em`/百分比（markdown 的标题、code 的 0.9em）留在原地 —— 它们要相对正文字号缩放，不是绝对档位

**阴影** `--shadow-sm|md|lg`；`line-height`（1.3/1.5/1.7）与动画时长（0.3s slide、0.8s spin、1s pulse）保留字面 —— 属排版比例与动画，不是节奏尺度

**允许字面的例外**：元素固有尺寸（48px 折叠宽、5px 分隔条、6px 把手、2×40px 指示条、12px spinner、18px 角标、60px 缩略图、120px 图片上限、220px 限高、180px 列表宽、280px `min-width`、1px 描边）与用户气泡那条着色阴影。每个文件头注明。

## 实现步骤
1. 新建 `src/styles/tokens.css`，`main.tsx` 引入
2. `App.tsx` 的桥删掉 `--app-radius*`，只留颜色
3. 6 个组件 CSS 的字面量全量换 `var()`：`App.css`、`Sidebar.css`、`MessageList.css`、`ChatInterface.css`、`PreviewArea.css`、`AgentProgress.css`

## 验收标准
- [x] `grep -rn "app-radius" src` 为空；`--app-*` 只剩颜色
- [x] 组件 CSS 里的字面 px 只剩"固有尺寸/1px 描边"这一类，且每个文件头有注明
- [x] 改前用 `getComputedStyle` 打基线、改后同条件复测：非对齐项零变化，变化项与档位表一一对应（见下方实测 diff）
- [x] `tsc -b` 仍是 4 个历史错误，无新增；`vitest` 25/25 通过
- [ ] 深色模式观感未逐屏确认

## 实测 diff（同一条会话、同一视图下对比）
| 元素 | 改前 | 改后 | 说明 |
|---|---|---|---|
| `.message-list` | `0 20px` | `0 16px` | 左右留白并档 |
| `.message-bubble-*` | `10px 14px` / 154×447 | `12px 16px` / 160×451 | 面板内统一内边距 |
| `.session-item` | `10px 12px` / 183×45 | `8px 12px` / 183×41 | 行高 −4px |
| `.sidebar-title` | 15px | 16px | 并档 |
| `.preview-header` | `6px 12px` / 45 高 | `8px 12px` / 49 高 | 并档 |
| `.send-btn` | 圆角 20px | 18px | pill 档 |
| `.code-viewer-path` / `.code-file` | `6px 12px` / 12px | `8px 12px` / `--font-xs` | 并档 |
| `.composer-box` | `12px 16px` / 18px / 228×118 | **完全相同** | 该项本就在档位上 |

## 待办（下一轮可选）
- 把 `Sidebar.tsx` 里内联 transition 字符串中的 `0.2s` 换成 `var(--motion-base)`
- 系统深色模式下逐屏走一遍，确认没有残留的浅灰底/深灰字
