# 流式期间对话流抖动 - SDD

## 需求

思考过程逐字输出时对话流一直小幅来回蹭，"思考中 → 执行工具"那一瞬还会猛地弹一下。
真因在滚动不在列表长度：`MessageList` 的追滚是 `useEffect(..., [messages, progress])` 里一次
`scrollIntoView({ behavior: 'smooth' })`，而 `runAgentLoop` 的 `emitProgress()` 每个 SSE chunk 调一次
（思考阶段每 token 一次，一秒十几到几十次）。smooth 是异步补间动画，目标位置在动画中途被改写、
又被下一次调用重新起坡，观感就是抖动。`scrollIntoView` 还会连带滚动祖先可滚动容器，外层是
`app-shell` 嵌套 flex，可能多滚一层。

已确认**不上虚拟列表**：`.message-list` 里一共几个气泡节点，不是渲染开销问题，虚拟列表治不了补间互相打断。

## 实现步骤

1. `utils/chatScroll.ts`（新，纯函数）
   - `isPinnedToBottom({scrollTop, scrollHeight, clientHeight}, threshold = 120)`：留阈值，新行刚插进来必然差一行高度。
   - `followScrollTop(geo, pinned)`：`pinned` 为 false 返回 null（用户在翻看历史，不打扰）；
     否则目标 `scrollHeight - clientHeight`，只在大于当前 `scrollTop` 时返回，相等/更小返回 null
     （写同样的值也会白触发一轮 scroll；收起长内容导致底部上移时浏览器已自己夹到底）。
2. `components/MessageList.tsx`
   - 删掉 `bottomRef` 与 `scrollIntoView`，改成 `listRef` + `onScroll` + rAF 待办标记。
   - **`pinnedRef` 只由 `scroll` 事件更新**，不在内容变化后现判几何：那时新行已经撑高，
     按新几何判会把"贴底"误判成"用户翻上去了"，从此再不追滚。
   - 追滚 effect：已有待办帧就直接返回，`requestAnimationFrame` 里读几何、写 `scrollTop`，一帧最多一次
     （`scrollHeight` 是读操作，会强制 flush layout）。
   - 卸载时 `cancelAnimationFrame`。
   - 换会话时重置 `pinnedRef = true` 并直接跳到底部：切会话是"看那条会话的最新处"，不延续上一条的浏览位置。
3. `components/MessageList.css`：末尾占位空 div 删掉后，它原先靠 flex `gap` 撑出的 12px 底部留白
   改由容器 `padding-bottom: var(--space-3)` 承担，视觉不变。

## 状态不变量自查

- 这段状态属于哪条会话：`pinnedRef` / `frameRef` 是**视图浏览位置**，不是会话内容。切会话时显式重置，
  避免把上一条会话的浏览位置带到新会话。
- 生成中切会话会怎样：追滚只作用于当前挂载的 `.message-list`；后台那一路的进度写在自己分片里，
  不会滚当前视图。

## 验收标准

验证方式：无头 Chrome（`--headless=new`）+ CDP `Runtime.evaluate`，在页面里逐帧采样 `scrollTop` 并钩住容器
`scrollTop` 的 setter 记录 JS 层写入；上游是离线假 Responses 服务（`node_modules/.scratch/fake-llm.mjs`），**不消耗模型调用**。
改前/改后跑的是同一份脚本（`cdp-scroll-probe.mjs`），改前那份用 `git show main:` 的 `MessageList.tsx` 临时替换。

- [x] `pnpm --filter web test:run` 全绿，含 `utils/__tests__/chatScroll.test.ts`（阈值内算贴底、
      非贴底不追、内容变长追到新底部、已到底返回 null、塌陷返回 null、不足一屏不产生负数目标）
      → **52 passed / 10 files**
- [x] `tsc -b` / `pnpm build` 绿，`pnpm --filter web lint` 不新增告警
      → build 936.36 kB / gzip 304.68；lint 仅 1 条既有告警（`Sidebar.tsx:155` exhaustive-deps）
- [x] 浏览器实测（离线假 Responses 上游，不消耗模型调用）：流式期间 `scrollTop` 序列**单调不回退**，
      没有补间来回蹭；`scrollTop` 写入次数 ≤ 帧数（一帧一次）
      → 改后：逐帧 124 采样**方向反转 0 次**，贴底滞后 max **44px**、滞后 >80px 的帧 **0**；
      118 次写入落在 118 个不同帧上（`maxWritesPerFrame = 1`）；30 条写入里 29 条"请求值 == 实际值"，没有超写后被夹。
      改前同一场景：贴底滞后 max **778px**，**100/126 帧**滞后 >80px —— 滚动一直在追、从未落定，就是观感上的抖。
- [x] 浏览器实测：内容静默增长期（工具参数流式中）不再产生滚动写入
      → 3s 静默窗口内取 2s 采样，写入 **0 次**
- [x] 浏览器实测：手动把列表往上翻之后，后续 token 不把视图拽回底部；翻回底部后追滚恢复
      → 上翻到 440 后 500ms 内写入 **0 次**、位置仍 440（其间内容从 1526 长到 2078）；滚回底部后 500ms 内恢复 27 次写入，top == bottom == 2178。
      改前：上翻后仍被继续滚动，且"滚回底部"只到 top 1539 / bottom 2190，差 651px 没跟上。
- [x] 换会话后视图落在该会话底部
      → 生成途中点新建会话（切到空会话 top 0），再切回原会话：改后 top **3084** == bottom 3084；
      改前 top **25** / bottom 3118，等于没落底。
- [x] 新增：思考块收起（内容从 4266px 塌到 431px）那一帧不多写一次滚动
      → 塌陷前后窗口内写入 **0 次**，位置由浏览器自行夹到底（`followScrollTop` 对"底部上移"返回 null）
- [x] 新增：rAF 待办标记与句柄同生同灭 —— cleanup 里 `cancelAnimationFrame` 之后必须置空 `frameRef.current`，
      否则 dev 下 StrictMode 的 setup → cleanup → setup 会让后续每次追滚都被守卫早退，追滚整体失效
      （实测第一版就是这样：内容撑到 1526px 而 `scrollTop` 全程 0、写入 0 次）。这条**单测与生产构建都不复现**。
