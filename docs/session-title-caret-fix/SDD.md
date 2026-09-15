# 会话标题点击出现文本光标 - SDD

## 需求
点击侧边栏会话标题会出现类似输入框的光标/选区，看起来标题是用 `input` 做的。

实测结论（dev 页面 DOM 探针）：会话标题**不是**输入框 —— 目标元素 `isInput: false`、`tag: DIV`、`cursor: pointer`，但 `user-select: auto`。也就是说浏览器允许选中/双击选中这段文本，出现选区与插入点，视觉上被当成"点击出现光标"。列表项内部也确实没有任何 `input`/`textarea`（重命名时才条件渲染）。

所以修法是把默认态的会话项声明为不可选中的纯展示文本，只有进入重命名编辑态才允许编辑与聚焦。

## 实现步骤

### 1. 会话项默认禁止文本选中
- 文件：`packages/web/src/components/Sidebar.css`
- `.session-item` 增加 `user-select: none`（含 `-webkit-user-select`）
- 编辑态例外：`.session-item input, .session-item textarea` 上恢复 `user-select: text`，保证重命名时仍可选中、编辑、复制

### 2. 去掉多余的可聚焦元素
- 当前左侧独立拖拽手柄带 `role="button" tabindex="0"`，点击会产生聚焦轮廓，同样会被看成"光标"
- 该手柄在 `session-item-drag-rework` 中整体移除，本条不重复实现，只在验收时一并确认

### 3. 不改动的部分
- 重命名仍走「⋯ → 重命名」，条件渲染的 `Input` 逻辑不变
- 点击切换会话、删除、改名提交逻辑不变

## 验收标准
- [ ] 单击/双击会话标题不产生文本选区，也不出现插入点
- [ ] 标题元素默认态计算样式为 `user-select: none`
- [ ] 进入重命名后输入框可正常聚焦、选中、编辑、回车提交、Esc 取消
- [ ] 点击会话项仍能正常切换会话
- [ ] `pnpm --filter web test:run` 通过
