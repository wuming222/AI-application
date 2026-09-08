# 慧应用 MVP-4：iframe srcdoc 预览 - SDD

## 需求

完成产品闭环的最后一环：Agent 通过工具把文件写入虚拟工作区后，用户能实时看到生成的应用在 iframe 中运行。同时在 UI 层修复 function_call 轮次显示 "..." 的问题。

MVP-4 **只做**：workspace 状态进 Zustand、srcdoc 组装器（内联 CSS/JS）、PreviewArea 组件 + 左右分栏布局、MessageList 工具摘要、runAgentLoop 最小系统提示词。**不做**：fetch/动态 import 转换（"医生诊断"管线）、错误回传 AI 自愈、文件树/代码视图、reasoning 折叠面板。

## 关键设计决策

### workspace 进 Zustand

现在 `VirtualFS` 是普通类单例，React 感知不到文件变化。改为 `store/workspaceStore.ts`（Zustand）：`files: Record<string, string>` + 原有四操作，工具执行写文件 → 订阅它的 PreviewArea 自动重渲染。`virtualFs.ts` 删除，`toolRegistry` 改从 workspaceStore 读写。

### srcdoc 组装策略（MVP 最简）

- 以 `index.html` 为入口，不存在则不显示预览
- `<link href="xxx.css">` → `<style>`，`<script src="xxx.js">` → `<script>`（按 files 字典内联，路径规范化复用原 VirtualFS 逻辑）
- **不做** fetch/import 转换；通过系统提示词约束模型"生成单文件 index.html，CSS/JS 全内联，不使用外部依赖"，从源头规避 srcdoc 沙箱限制
- iframe 用 `sandbox="allow-scripts"`（无 allow-same-origin，opaque origin，隔离父页面）

### runAgentLoop 系统提示词

每次循环注入固定 system 消息：告知 Agent 有虚拟工作区工具、应用需单文件 index.html 内联资源。这是预览能跑通的前提，属于 MVP-4 范围。

### MessageList 显示修复

- `role: 'tool'` 消息不在消息列表渲染（结果已在 AgentProgress 可见），但保留在发给 LLM 的历史里
- assistant 消息 content 为空但有 tool_calls 时，渲染工具调用摘要（如 `🔧 write_file: index.html`）替代 "..."

### 联调发现与修复

**1) Responses API 输入格式转换（`toResponsesInput`，curl 实测确认）**

DashScope Responses API 不接受内部 Message[] 原始格式，全部差异在 provider 层消化：

| 内部格式 | Responses API input 项 | 验证结果 |
|---|---|---|
| `role:'system'` | ❌ 无对应形式（system/developer role 和 instructions 参数均返回 InvalidParameter） | 系统提示词合并进首条 user 消息 |
| `role:'user'` | `{role:'user', content}` | ✅ |
| `role:'assistant'` | `{role:'assistant', content}` | ✅（多轮记忆正常） |
| assistant 带 tool_calls | `{type:'function_call', call_id, name, arguments}` | ✅（可与 assistant 文本消息同轮共存） |
| `role:'tool'` | `{type:'function_call_output', call_id, output}` | ✅ |

这也解释了 MVP-3 时第二轮回复 "..." 的真正根因：`{role:'tool'}` 消息被上游静默忽略，模型从未收到工具结果。

**2) 沙箱存储 shim（`STORAGE_SHIM`，E2E 实测发现）**

`sandbox="allow-scripts"`（无 allow-same-origin）的 iframe 是不透明源，访问 `localStorage`/`sessionStorage` 直接抛 SecurityError——AI 生成的待办应用第一行就崩，整个预览是死的。`buildSrcdoc` 在 `<head>` 开头注入 shim：探测存储访问，抛错则用内存 Map 顶替。沙箱隔离性保持不变（不用 allow-same-origin 换便利）。

**3) 代理流式中断的真正根因**

`_proxy_to_upstream` 原来用 `async with httpx.AsyncClient(...)` 包住请求，但 context 在返回 StreamingResponse **之前**就退出、连接被关闭，生成器只能吐出已缓冲的 ~1KB（恰好一次 chunk_size）后静默 EOF。修复：client 不用 context manager，在流式生成器的 `finally` 里关 upstream + client。之前归因为 aiter_bytes chunk_size 是误诊。

## 实现步骤

1. `store/workspaceStore.ts`：Zustand 化文件操作；`toolRegistry.ts` 改接入；删 `virtualFs.ts`
2. `preview/buildSrcdoc.ts`：入口 HTML + 内联替换 + 存储 shim 注入
3. `components/PreviewArea.tsx`：iframe + srcdoc + 刷新按钮；`App.tsx` 左右分栏
4. `runAgentLoop.ts`：注入 system 提示词
5. `MessageList.tsx`：过滤 tool 消息 + 工具摘要
6. `llm/providers/responses.ts`：`toResponsesInput` 格式转换
7. `server/app/routes/llm.py`：修复流式代理 client 生命周期
8. 验证：生成应用 → 预览渲染 → 多轮迭代 → 中止

## 验收标准

- [x] "创建一个待办事项应用" → Agent 调 write_file → 右侧 iframe 渲染出可交互页面
- [x] 第二轮"把标题改成 X" → 文件更新（先 read_file 再 write_file）→ 预览自动刷新
- [x] 无 index.html 时不显示预览区（占位文案）
- [x] function_call 轮次显示工具摘要而非 "..."
- [x] tool 消息不重复出现在聊天列表
- [x] 中止按钮正常，类型检查通过
- [x] 所有 LLM 请求走 `/api/llm/responses`（SSE），控制台无 JS 报错
