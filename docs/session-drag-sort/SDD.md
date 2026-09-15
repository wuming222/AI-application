# 会话列表拖动排序 - SDD

## 需求
当前侧边栏的会话列表按固定顺序显示，用户无法自定义排序。需要添加拖动排序功能，让用户可以通过拖拽会话项来调整显示顺序，并将排序结果持久化到本地存储，下次打开时保持用户自定义的顺序。

## 实现步骤

### 1. 安装依赖
```bash
cd packages/web
pnpm add @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities
```

### 2. 修改 Sidebar 组件
- 文件：`packages/web/src/components/Sidebar.tsx`
- 导入 `DndContext`, `SortableContext`, `useSortable` 等 dnd-kit 组件
- 将现有会话列表渲染逻辑包装到 `SortableContext` 中
- 为每个会话项创建可拖动的包装组件
- 实现 `onDragEnd` 回调处理排序变更

### 3. 实现排序持久化
- 文件：`packages/web/src/store/sessionStore.ts` 或 `chatStore.ts`
- 在 store 中添加 `sessionOrder` 状态（字符串数组，存储 sessionId 列表）
- 从 localStorage 读取保存的排序
- 拖拽结束后更新排序并保存到 localStorage

### 4. 添加拖动视觉反馈
- 文件：可能需要新增 CSS 或修改现有样式
- 拖动时显示半透明效果
- 拖动目标位置显示高亮提示
- 添加拖动手柄图标（可选）

### 5. 测试拖动交互
- 验证拖拽后列表顺序正确更新
- 刷新页面后排序保持不变
- 删除会话后排序自动调整
- 新建会话添加到合适位置

## 验收标准
- [ ] 安装 @dnd-kit 相关依赖成功
- [ ] Sidebar 组件中集成拖拽功能
- [ ] 可以拖动会话项改变顺序
- [ ] 拖动时有视觉反馈（半透明、高亮等）
- [ ] 排序结果保存到 localStorage
- [ ] 刷新页面后保持自定义排序
- [ ] 不影响现有的会话选择、删除等功能
