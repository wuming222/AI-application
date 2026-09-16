# 捕获预览运行时错误并回灌给 Agent - SDD

## 需求
Agent 生成完就撒手：预览 iframe 里报了什么错、应用有没有真跑起来，前端不知道，模型也不知道。要把运行时错误收上来，让用户能一键把它变成修复请求送进对话。

## 可行性依据（已实测，不是推断）
在跑着的页面上挂了一个 `sandbox="allow-scripts"` 的隐藏 iframe（与 `PreviewArea.tsx:30` 同样属性）做实验，注入脚本里写 `window.onerror` + `parent.postMessage`，并放一行 `//# sourceURL=app.js`，结果：

| 观察项 | 实测值 | 结论 |
|---|---|---|
| `event.origin` | `"null"` | 不透明源，**不能**用 origin 做校验 |
| `event.source === iframe.contentWindow` | `true` | 来源校验要用这个 |
| 回传 `src` / `line` / `stack` | `"app.js"` / `6` / `at app.js:6:31` | `sourceURL` 生效，**行号是文件内相对行号**，可直接给模型定位 |
| `unhandledrejection` | 捕获到 `kind:"rejection"`、`msg:"module-rejected"` | Promise 未处理拒绝可收 |
| `type="module"` + `sourceURL` | `src:"mod.js"`、`line:9` | 模块脚本同样归因到文件名，行号是模块内相对行号 |

两次实验用的是与 `PreviewArea.tsx:30` 相同的 `sandbox="allow-scripts"`（不带 `allow-same-origin`），所以结论可直接套用。

## 端到端链路

三条底层事实决定了链路的形状：

1. 运行时错误在浏览器里是 `ErrorEvent` / `PromiseRejectionEvent` 对象，**只存在于 iframe 那个 JS realm**，父页面拿不到；
2. 跨 realm 唯一通道是 `postMessage`（结构化克隆）→ 必须先**拍平成纯数据**才能出来；
3. 父侧能信任的身份信号只有 `event.source`，`origin` 在不透明源下恒为 `"null"`，没有区分能力。

```
[生成期] buildSrcdoc 内联 app.js
  <script> 体末尾追加  //# sourceURL=app.js
      ↓ 浏览器把这段内联脚本登记为"名为 app.js 的资源"
  错误里的位置 = app.js:6:31，而非 srcdoc:271:31     ← 归因在这一刻定死

[运行期 · iframe 内]
  app 代码抛错
      ↓
  ① 桥接脚本（注入 <head> 顶部，早于 app 代码执行）
     addEventListener('error')               ← 同步/解析期未捕获错误
     addEventListener('unhandledrejection')  ← Promise 未处理拒绝
      ↓ 拍平成白名单字段
     { type:'__pe:error', payload:{ message, kind, source, lineno, colno, stack≤2000 } }
      ↓ 双写
     ② window.__peBuffer.push(...)   （上限 50，防父侧 listener 未挂）
     ③ parent.postMessage(payload, '*')
      │
      │  跨 realm 边界（structured clone；error 对象本身不过去）
      ↓
[父侧 · PreviewArea]
  ④ message handler 三道闸：
     event.source === iframeRef.current.contentWindow → 不是本 iframe 发的，丢
     data.type === '__pe:error'                       → 不是错误协议，丢
     逐字段收窄成白名单形状                             → 形状不合，丢
      ↓
  ⑤ previewErrorStore.addErrors(sessionId, normalized)
     去重键 message + source + lineno ；每会话上限 20 ；只存内存不入库
      ↓
  ⑥ 两个消费者
     UI：预览顶部红条 → 展开列表（React 文本节点渲染）
     动作：「填入输入框」→ chatStore.setDraft(修复请求文本)

[回到模型]
  ⑦ ChatInterface effect 消费 pendingDraft → 用户按发送
  ⑧ chatStore.sendMessage → runAgentLoop → 模型看到的是 app.js:6:31 这种可直接定位的行
  ⑨ 模型 edit_file / write_file → workspaceStore 变 → srcdoc 重算 → iframe 重载
     → 桥接脚本重新注册 → 新一轮错误回到 ①
```

| 机制 | 解决什么 | 为什么不能省 |
|---|---|---|
| `//# sourceURL` | 行号归因 | 没有它，模型拿到的是整份内联文档的行号，对着 `index.html` 找不到位置 |
| `__peBuffer` + replay | 首批错误竞态 | iframe 可能在 React 挂上监听前就把错抛完；父侧随后发 `{type:'__pe:replay'}` 把缓冲捞回 |
| `event.source` 比对 | 来源身份 | 不透明源下 `origin` 无区分能力，光看 origin 等于不设防 |

**信任边界（要说清）**：`event.source` 能挡住别的 frame / 顶层窗口发来的消息，但**挡不住同一个 iframe 内部伪造 payload** —— 生成应用自己也能调 `parent.postMessage({type:'__pe:error',...})` 编一条假错误。所以 ④⑤ 之后这份数据只当"文本"用：进 React 文本节点、进给模型的字符串，绝不作为指令执行、不进 `dangerouslySetInnerHTML`。最坏情况是模型收到一条用户没看到的假报错，而不是任意代码执行。

## 实现步骤

### 1. 行号归因：内联时给每个文件加 sourceURL
- 文件：`packages/web/src/preview/buildSrcdoc.ts`
- 脚本内联处（把 `<script src>` 换成 `<script>` 内联体的地方）在内容末尾追加 `\n//# sourceURL=<原始文件路径>`
- 样式内联处追加 `\n/*# sourceURL=<原始文件路径> */`
- 实测确认（含 `type="module"` 脚本）：加了 `sourceURL` 后回传的 `filename` 就是原文件路径，行号是该文件内的相对行号，不需要额外映射
- 兜底：若某浏览器不认 `sourceURL`（`filename` 回落到文档 URL），错误文本里改为附带一张"srcdoc 行号 → 原文件"的偏移表，让模型自己对照

### 2. 错误桥接脚本
- 文件：`packages/web/src/preview/buildSrcdoc.ts`，与 `STORAGE_SHIM` 同机制注入到 `<head>` 顶部
- 职责：
  - `window.addEventListener('error', ...)` 捕获运行时异常与资源加载错误（资源错误要区分：`event.target !== window` 时只取 `src`/`tagName`，没有行号）
  - `window.addEventListener('unhandledrejection', ...)` 捕获未处理的 Promise rejection
  - 每条错误先存进 iframe 内 `window.__peBuffer` 数组（上限 50，超出丢最旧的），再 `parent.postMessage({ type: '__pe:error', ...}, '*')`
  - 收到 `parent` 发来的 `{ type: '__pe:replay' }` 时把缓冲区重放一遍
- 为什么要缓冲 + 重放：iframe 文档解析可能早于父侧 listener 挂上，只靠即时 post 会漏掉首批错误
- 字段收窄：只回传 `{ message, kind: 'error'|'promise'|'resource', source, lineno, colno, stack(截 2000 字符) }`，**不回传** `error` 对象本身，避免不可序列化内容与意外夹带

### 3. 父侧接收
- 文件：`packages/web/src/components/PreviewArea.tsx`
- 持有 iframe 的 ref；`useEffect` 里挂 `message` 监听
- 校验顺序：`event.source === iframeRef.current?.contentWindow` → 再校验 `data.type === '__pe:error'` → 再逐字段收窄成白名单形状。任一不满足直接丢弃
- 触发时机：iframe 挂载或 `srcdoc` 变化后，向 iframe `postMessage({ type: '__pe:replay' }, '*')` 拉一次缓冲，兜住首批错误竞态
- `srcdoc` 变化（新一轮生成）与 `manualKey` 重挂载时清空该 generation 的错误缓冲

### 4. 按会话存 + 去重上限
- 新文件：`packages/web/src/store/previewErrorStore.ts`
- 形状：`errorsBySession: Record<string, PreviewError[]>`、`addErrors`、`clearErrors`
- 去重键：`message + source + lineno`；同一会话上限 20 条
- 只存内存，**不入库**（运行时产物，刷新即失效；和 `app.db` 一个道理）

### 5. UI：错误条 + 填入输入框
- 文件：`packages/web/src/components/PreviewArea.tsx`（+ `PreviewArea.css`）
- 预览视图顶部：有错误时显示红条「N 个运行时错误」，可展开看列表（消息、`文件:行`、堆栈前几行）
- 按钮「填入输入框」：把错误拼成修复请求写进 composer，**不自动发送**
- 输入框落点：`chatStore` 加 `pendingDraft: string | null` 与 `setDraft(text)`，`ChatInterface` 用 effect 消费并清空（`input` 本来就是受控的，接一个初值即可）
- 修复请求文本模板要包含：错误列表、出错文件名、以及"请只改这些文件并保持其余功能不变"这类约束

### 6. 自动修复（默认关）
- `previewErrorStore` 加 `autoRepair: boolean`（默认 `false`，localStorage 持久化用户选择，包 try/catch）
- 开启时：`chatStore.sendMessage` 的一轮结束（`runAgentLoop` 返回）后，等一个短窗口（约 3s，等异步报错浮出来）→ 若该 generation 有未处理错误，自动发一轮修复
- **硬上限**：同一次生成最多自动修复 1 轮；自动修复产生的新错误不再自动触发第二轮，只在错误条上提示。这条是防"错误→修→错"无上限烧 token 的关键
- 自动发送前在界面上明确提示"将自动发送 1 轮修复"，让用户看得见

### 7. 明确不做
- 不 hook iframe 的 `console.log/error`（噪音大，且与"运行时错误"不是一回事）
- 不做 sourcemap（生成的是裸代码，没有映射表）
- 不给 iframe 加 `allow-same-origin` 来"方便读取"——那会打破沙箱隔离与现有 storage shim 的前提

## 验收标准
- [ ] 生成一个会抛错的页面（如引用未定义变量），预览里能看到错误条，展开有消息与 `文件:行`
- [ ] `source` 显示的是原始文件名（如 `app.js`）而不是整份 srcdoc 的行号
- [ ] 抛错发生在首屏初始化时（父侧 listener 尚未挂上）也不漏报
- [ ] 非本 iframe 发来的 message（比如生成应用自己 `postMessage` 到 parent、或同源页面的其它 frame）不会被计入
- [ ] 同一错误重复触发只记一条；超过 20 条后不再增长
- [ ] 点「填入输入框」后 composer 里是完整修复请求，且没有自动发送
- [ ] 新一轮生成开始后错误条清空
- [ ] `autoRepair` 关闭时不会自动发任何消息；开启时一次生成最多自动修 1 轮，第二次的错误只提示不发送
- [ ] 去重/上限/归属校验逻辑有单测覆盖
- [ ] `pnpm --filter web test:run` 通过；`npx tsc -b` 不新增错误
- [ ] 现有行为无回归：预览保活、代码视图、下载、存储 shim 都照旧

## 开放问题（需要定）
1. **自动修复默认关是否可接受？** 倾向默认关：先让错误可见 + 一键填入输入框，跑一段时间再决定要不要放开。理由是"错误 → 修 → 又错"这条链即使有 1 轮上限，也可能修出更差的结果，而且会在无人看管时花 token。
2. ~~`type="module"` 的 `sourceURL` 行为~~ —— 已实测关闭：模块脚本同样归因到文件名、行号为模块内相对行号，不需要偏移表兜底。
