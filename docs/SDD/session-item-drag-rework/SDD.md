# 会话列表项去掉前置图标并改为整项长按拖动 - SDD

## 需求
1. 会话项前面的消息气泡图标（`MessageOutlined`）不需要，去掉，只留标题文本。
2. 拖动目前必须先按住左侧那个独立的小手柄图标才能触发，交互别扭。期望直接按住整条会话项、稍等一下就能拖，不必瞄准特定图标；同时轻点仍然是切换会话，不会误触发拖动。

## 实现步骤

### 1. 收敛双层结构：SortableSessionItem 自己就是那张卡片
- 文件：`packages/web/src/components/Sidebar.tsx`
- 现状问题：外层 `div`（`Sidebar` 里）承载 padding/背景/边框等卡片样式，内层 `SortableSessionItem` 的 `div` 才挂 `setNodeRef`/`transform`。拖动时只有内层在动，卡片视觉与位移不在同一节点上
- 改成由 `SortableSessionItem` 渲染唯一的那个节点，把外层卡片样式（padding、背景、边框、圆角、阴影、字号）合并进来，`ref`/`style`/`attributes`/`listeners` 全部挂它
- 删掉 `Sidebar` 里那层只做样式容器的外层 `div`

### 2. 移除前置图标
- 删掉 `<MessageOutlined />` 及其 import
- 标题文本所在的两层 `div`（外层 `flex:1` + 内层 ellipsis）压成一层，直接由 `.session-item` 承担省略号与溢出

### 3. 移除独立拖拽手柄
- 删掉 `.drag-handle` 那个 `div` 与 `DragOutlined` import
- `{...attributes} {...listeners}` 移到第 1 步的整项节点上
- 文件：`packages/web/src/components/Sidebar.css` 删掉 `.drag-handle`、`.session-item:hover .drag-handle`、`.drag-handle:active` 三段样式

### 4. 拖动激活方式改成长按
- 文件：`packages/web/src/components/Sidebar.tsx`
- `useSensor(PointerSensor, { activationConstraint: { distance: 8 } })`
  改为 `{ activationConstraint: { delay: 250, tolerance: 5 } }`
- 语义：按住 250ms 才进入拖拽；期间移动超过 5px 则判定为普通操作（滚动/点击）而取消激活
- 轻点（未按住）不会触发拖拽，`onClick` 仍能 `switchSession`

### 5. 别让整项监听吃掉项内按钮的操作
- 「⋯」下拉菜单按钮加 `onPointerDown={(e) => e.stopPropagation()}`，避免在它上面按下时启动长按计时
- 编辑态（重命名输入框）同理：整项的 `listeners` 在 `isEditing` 时不挂，避免在输入框里选字被当成拖拽

### 6. 无障碍
- `attributes` 会把 `role="button"`/`tabIndex=0`/键盘拖拽说明带到整项上，保留
- 鼠标点击不应出现聚焦轮廓：给 `.session-item:focus-visible` 才显示 outline，避免与上一条需求里的"看着像光标"混淆

## 已知取舍
- 不给会话项设 `touch-action: none`：那会让触屏下无法上下滚动会话列表。当前长按方案面向桌面鼠标，触屏拖拽暂不支持。

## 验收标准
- [x] 会话项前没有图标，只有标题文本，超长仍是省略号（实测 `.anticon-message` 数为 0）
- [x] 页面上不再存在独立拖拽手柄元素（实测 `.drag-handle` 数为 0）
- [x] 按住整条会话项约 250ms 后上下移动，可以重排顺序（长按 340ms 拖动实测首两项成功换位）
- [x] 长按判定期间移动超过 5px 不会误触发拖拽（实测 40ms 时移动 30px：顺序未变，只切了会话）
- [x] 快速点击会话项只切换会话，不产生拖动
- [ ] 「⋯ → 重命名 / 删除」仍然可用；重命名输入框内可正常选中文本 —— 代码层已加 pointerdown 阻断与 user-select 例外；in-app 浏览器视口隐藏、无法用真实指针打开菜单，未实测
- [x] 排序结果仍持久化到 localStorage，刷新后顺序保持
- [x] 拖动结束后卡片样式与位移在同一节点上，无残留错位
- [x] 拖拽中高亮真实生效（评审 [M1] 修复后实测 `opacity: 0.5` + `background-color: rgba(107,159,212,0.1)`）
- [x] 拖动结束补发的 click 不会误切会话（dnd-kit 吞掉该 click，实测顶栏标题不变）
- [x] `pnpm --filter web test:run` 通过（12/12）
