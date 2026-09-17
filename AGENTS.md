# AGENTS.md

项目级 agent 指令文件（等价于 CLAUDE.md）。在此仓库工作的任何 agent 先读本文再动手。

## 项目是什么

浏览器内 AI 应用生成平台：用户用自然语言描述需求，Agent 主循环在内存虚拟文件系统里生成前端代码，右侧 iframe 实时预览，支持多轮迭代修改。附带多会话管理、语音输入、Markdown 渲染。

**注意**：`README.md` 内容已陈旧（仍写着 React 18、"不做语音/多会话/持久化"，这些实际都已实现）。以代码和本文件为准，不要据 README 判断项目现状。

## 常用命令

包管理用 **pnpm**（workspace 根目录执行，`pnpm-lock.yaml` 已提交）。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 前端 Vite dev server（默认 5173） |
| `pnpm dev:server` | 后端 `uvicorn app.main:app --reload --port 8000` |
| `pnpm --filter web test:run` | 前端单测（vitest，当前 78 用例） |
| `pnpm --filter web lint` | oxlint |
| `pnpm build` | `tsc -b && vite build` — 通过；只剩主 chunk 体积提示，见「已知坑」 |

Python 依赖：`packages/server/pyproject.toml`（fastapi / uvicorn / httpx / python-dotenv / websockets）。Windows 下没有 `pip` 命令，用 `python -m pip install ...`。

## 架构地图

```
packages/web/src/
  agent/runAgentLoop.ts    Agent 主循环（多轮 tool call、进度流）
  agent/toolRegistry.ts    虚拟文件系统工具：write_file / read_file / list_files / delete_file / edit_file；外加外部工具的注册与按 server 筛选
  agent/externalTools.ts   拉取 MCP 工具清单并注册进 registry，持有逐 server 全局开关（localStorage `mcp-servers-enabled`）
  agent/contextBudget.ts   上下文截断（先语义压缩、再硬截断，保证 tool 配对）
  llm/router.ts            按 VITE_LLM_PROVIDER 选 provider
  llm/providers/responses.ts  OpenAI Responses 流式协议 + 内置 web_search 工具事件
  llm/providers/mock.ts    无 key / 断网可跑通全链路
  preview/buildSrcdoc.ts   iframe srcdoc 实时预览（注入 localStorage/sessionStorage 内存 shim）
  store/                   zustand：chatStore / sessionStore / workspaceStore
  styles/tokens.css        静态设计令牌（space/radius/font/shadow/mono/motion）
  App.tsx useThemeVars()   主题派生颜色桥成 --app-*，与 tokens.css 两层分开
  hooks/useVoiceInput.ts   麦克风采集 + PCM 编码，连后端 WS
packages/server/app/
  main.py                  FastAPI 入口，import 时 init_db()，注册四个 router
  routes/llm.py            /api/llm/{chat/completions,responses,title}，转发上游并注入 key
  routes/sessions.py       /api/sessions CRUD + /messages + /workspace
  routes/mcp.py            /api/mcp/tools（TTL 缓存 + 逐 server 容错）与 /api/mcp/call（恒 200，错误在 body）
  routes/voice.py          /api/voice/ws → DashScope 实时 ASR
  mcp/client.py            手搓的最小 MCP 客户端（Streamable HTTP + SSE 双传输，trust_env=False，每次调用一条会话）
  mcp/servers.py           已接入 server 的写死配置与 DashScope 鉴权头（key 只在服务端）
  database.py              SQLite（WAL + 外键），CREATE TABLE IF NOT EXISTS + 轻量 ALTER 迁移
```

## 联调链路与端口

LLM 请求有两条通路，取决于 `packages/web/.env` 里的 `VITE_API_BASE_URL`：

- **为空** → `/api/llm/*` 命中 `vite.config.ts` 的 proxy，直连 `LLM_BASE_URL` 并在 dev server 侧注入 `Authorization`。此路径只在开发环境成立，且 `/api/sessions` 会 404。`/api/mcp/*` 同样不在 proxy 白名单里，但失败形态不同：vite 把它当前端路由回成 SPA 外壳（200 text/html），`res.json()` 抛异常 → 一个外部工具都不注册，界面静默退化成"没有 MCP"，不报网络错误。
- **非空**（如 `http://localhost:8000`）→ 会话、LLM、语音全部走 FastAPI，key 由服务端注入。**这是当前使用的模式。**

因此：改了 uvicorn 端口，必须同步改 `VITE_API_BASE_URL`，否则前端报网络错误。`main.py` 的 CORS 白名单只放开 `localhost:5173~5178`，换端口要一起加。

`packages/server/data/app.db` 是运行时生成的本地数据（含本地会话记录），已 gitignore，**不要提交**。

环境变量：`packages/web/.env.example` 与 `packages/server/.env.example`，两边各自维护一份 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，值不要写进任何被提交的文件。

## 编码约束

- TypeScript 开了 `verbatimModuleSyntax`：类型必须用 `import type { X }`，否则编译报错。
- 开了 `noUnusedLocals` / `noUnusedParameters`：残留的未使用导入直接让构建失败。
- 技术栈固定：React 19 + Ant Design 6 + Zustand 5 + Vite。
- **样式归属**：状态样式与布局样式写在同名 `.css` 的 class 里（如 `Sidebar.css`、`PreviewArea.css`），JSX 的 `style` 只放运行时才知道值的动态量（transform、用户决定的宽度）。同节点上的 inline style 会覆盖 `.css` 里的状态规则，已踩过：`.session-item.dragging` 的高亮被 inline `background` 盖掉。
- **流式追滚**：不要用 `scrollIntoView({ behavior: 'smooth' })` 追流式输出 —— `emitProgress()` 每个 SSE chunk 调一次（思考阶段每 token 一次），补间动画会被下一次调用重新起坡，观感就是抖动；且它会连带滚动祖先可滚动容器，外层是 `app-shell` 嵌套 flex 时会多滚一层。当前做法：写 `el.scrollTop` + 贴底判定（`utils/chatScroll.ts`）+ rAF 合帧。**贴底状态只能由 `scroll` 事件更新**，在内容变长之后现判几何会把"贴底"误判成"用户翻上去了"，从此再不追滚。**rAF 待办标记要与句柄同生同灭**：cleanup 里 `cancelAnimationFrame` 之后必须把 `frameRef.current` 置空，否则 dev 下 StrictMode 的 setup→cleanup→setup 会让后续每次追滚都被 `!== null` 守卫早退（追滚整体失效，而单测和生产构建都不复现，只能靠浏览器实测抓到）。
- **取值（两层，别混）**：
  - 静态尺度 → `src/styles/tokens.css`：`--space-1..5`(4/8/12/16/32)、`--radius-xs|sm|lg|pill|full`(4/8/12/18/999)、`--font-xs..xl`(12/13/14/16/18)、`--shadow-sm|md|lg`、`--motion-fast|base`、`--font-mono`。组件 `.css` 里不要再写字面 px。
  - 主题派生颜色 → `App.tsx` 的 `useThemeVars()` 桥成 `--app-*`。antd v6 在这里**没有**把 token 暴露成全局 `--ant-*` 变量（实测组件节点上 `getPropertyValue('--ant-color-text')` 取不到），所以必须运行时从 `theme.useToken()` 取；`main.tsx` 已配 `colorPrimary` 与跟随系统的 `darkAlgorithm`，写死的颜色在深色模式下会和 antd 表面打架。圆角/间距/字号不要搬回这个桥，否则同一值两套来源。
  - **例外（允许字面 px）**：元素自身的固有尺寸 —— 折叠宽 48px、分隔条 5px、调宽把手 6px、指示条 2×40px、spinner 12px、角标 18px、缩略图 60px、图片上限 120px、滚动限高 220px、列表宽 180px、`min-width: 280px`、1px 描边。这类值不是节奏尺度，留在组件里即可，但要在文件头或该行注明原因。
  - 阴影与"叠在特定底色上"的半透明白/黑（如用户气泡内的 `rgba(255,255,255,.x)` 与它的着色阴影）保留字面值 —— antd 的 `boxShadow*` 明显更弱，替换会造成可见回归。
  - antd 组件自身的 `disabled` / 选中态视觉由组件管理，不要再为这类状态写 inline style。
- **优先用组件库**：能用 antd 组件表达的交互不要手写裸标签 —— 分段切换用 `Segmented`（不要裸 `<button>` + 自制 active 样式），悬停提示用 `Tooltip`（不要用 `title` 属性），按钮优先 `Button`。但**视觉取舍以实际效果为准**：antd 形态若确实不如原有写法，允许保留原生元素，前提是就地注明理由并把样式收进 class（已生效的例外：`ChatInterface` 的 18px 图片移除角标、`PreviewArea` 的多文件列表行）。不要不设前提地把所有裸标签换掉。
- 浏览器侧偏好统一存 localStorage（现有 key：`session-order`、`sidebar-width`），必须包 try/catch —— 隐私模式/配额满会抛异常。
- `toolRegistry` 工具的 `args` 类型是 `Record<string, unknown>`，取值要显式收窄后再用，别直接当 ReactNode / string 用。

## 工作流程约定

`docs/` 分两个父目录：`docs/origin/` 放原始需求与外部输入，`docs/SDD/` 放产出方案。

- 每日需求记在 `docs/origin/YY-M-D.md`（日期不补零，如 `docs/origin/26-9-15.md`）。当天没有文件就新建。
- 每个特性一份轻量 SDD：`docs/SDD/{feature-key}/SDD.md`。一个特性有多份文件（如 `ai-app-gen-mvp` 的 SDD-MVP1~6）时同放该目录；`personal-check` / `personal-review` 的 `test-report.md`、`review-report.md` 也落这层。特性的外部输入与需求澄清放对应的 `docs/origin/{feature-key}/`。
- 开发在 `feature/{name}` 分支上做，base 为 `main`，合并用 `--no-ff` 保留 merge commit（与历史一致）。
- 有 personal 系列 skill 可用：`personal-plan` → `personal-develop` → `personal-check` → `personal-review`，或用 `personal-workflow` 总控批量跑完当日需求。
- `.claude/personal-workflow.json` 是本地流程状态文件，已 gitignore，不要提交。

## 状态不变量（改状态前先读）

界面是**多会话**的，所以任何与对话相关的状态都必须回答一句话：**它属于哪条会话**。下面的规则是踩出来的，不是风格偏好。

- **聊天状态按会话分片**：`chatStore.bySession[sessionId] = { messages, progress, isStreaming }`。不允许全局单槽的会话状态 —— 单槽会让后台那一路把旧会话的消息/进度画到用户当前看的会话上。
- **视图只读当前会话那一片**：`MessageList` / `ChatInterface` 都用 `currentSessionId` 去取分片；空态的条件是"该会话无消息**且**该会话没在生成"。
- **循环写入必须定向**：`runAgentLoop` 的 `onProgress` 和收尾 `set` 只能写回发起时捕获的 `sessionId`；用自增的代际标记（`streamSeq`）挡住被顶替/已中止那一路的迟到写入，结果作废就不写库。
- **进度必须覆盖"无正文产出"的阶段**：模型吐函数调用参数时一个字也不会产出（一个完整 HTML 几千 token、几十秒），provider 不显式 yield 界面就冻在最后一条 thinking 上。现有链路：`responses.ts` 在 `output_item.added(function_call)` yield `function_calls` → `runAgentLoop` 用 `mergeToolCalls` 立刻把该步置成 `tool-call` 并标 `running`，`registry.execute` 返回才转 `done`。**新增任何 LLM 事件类型时先问一句：它是否走到了 `emitProgress`？** 长时间没有可渲染事件的阶段还要有无进展提示（`agent/stallWatch.ts`，只提示不中断）。
- **工具与工作区读写显式带 sessionId**：`workspaceStore` 的所有方法首参都是 `sessionId`，`toolRegistry` 通过 `ToolContext` 拿。任何"隐式读 `currentSessionId`"的写法，都会让后台生成把文件写进用户当前打开的另一条会话。
- **落库时机**：整轮跑完才 `saveMessages` / `saveWorkspace`；中断即丢，避免半截 assistant 与悬空 tool 结果。`saveWorkspace` 是**全量覆盖**（`PUT /sessions/:id/workspace` 用 `ON CONFLICT DO UPDATE`），所以目标会话写错就是抹掉别人的代码 —— 宁可不写。
- **同时只一路**：`streamSessionId` 全局唯一；在别的会话发送时先 `abortStream()` 那一路并 `antdMessage.info` 明确提示，被中断那一路的分片回到本轮开始前。
- **外部工具是全局的，两件事例外于上面的分片纪律**：`registry` 仍是进程级单例、只 `register` 不 `unregister`；开关是**全局偏好**（localStorage 单 key `mcp-servers-enabled`），不进 `bySession`、不落库。且外部工具执行器**永不读写 `workspaceStore`**，结果只作为 `role:'tool'` 文本进上下文。理由：工具清单与开关不属于任何一条会话，做成会话状态反而会让后台那一路改到用户当前看的会话。代价是生成中途翻开关不影响在飞那轮（definitions 在每次 `runAgentLoop` 开始处只读一次）。新增"与对话有关"的全局状态前先问一句：它真的不属于任何会话吗？
- **删除会话**：若删的正是生成中的那条，先中止再落库/清分片。

改这类代码前必答的两个问题：**这段状态属于哪条会话？生成进行到一半时切换会话会怎样？** 两者都要在 `docs/SDD/{key}/SDD.md` 的验收标准里落成可勾的跨会话用例。

## 已知坑

1. **`pnpm build` 已可用**：`tsc -b` 干净通过（此前的 4 个历史类型错误在会话状态隔离那次一并清掉了）。只剩一条提示：主 chunk 953 kB / gzip 309 kB（antd + highlight.js；MCP 开关面板之后），未做代码分割。**验证优先用 `pnpm --filter web test:run`（78 用例），build 绿不代表交互没问题。**
2. **ASR 协议不通用**：语音走 DashScope 原生 WS 协议（`voice.py:16` 的 `wss://dashscope.aliyuncs.com/api-ws/v1/inference` + run-task 握手），模型 `qwen-audio-3.0-asr-flash-streaming`，不能按 OpenAI realtime 协议改。
3. **Responses 协议下 `input_image.image_url` 传的是字符串**（见 `responses.ts:24`），不是 `{ url }` 对象，改多模态时别按 OpenAI 文档的形状写。
4. **预览 iframe 的 `sandbox="allow-scripts"`（`PreviewArea.tsx:91`）刻意不带 `allow-same-origin`**：iframe 因而是不透明源，AI 生成的应用访问 `localStorage` 会抛 SecurityError，由 `buildSrcdoc.ts` 注入的内存 shim 兜住。不要为了排查问题给 sandbox 加权限，也别删这个 shim。副作用是父页面读不到 iframe 内部，要收运行时错误只能靠注入脚本 `postMessage` 回传（见 `docs/SDD/preview-error-capture/SDD.md`）。
5. 单测覆盖 agent / llm / store / preview / utils 的纯逻辑（78 用例）；**UI 交互没有自动化测试** —— 长按拖动、拖宽侧边栏与聊天列、代码视图高亮、预览保活这类改动改完要在浏览器实操验证。该仓库也没有视觉回归测试，用 `getComputedStyle` 打基线再复测是当前可行的比对手段。组件级行为（effect 清理、StrictMode 双跑）单测同样抓不到，见坑 6。
6. **浏览器实测的时序**：一次生成的中间态只存在几秒，而 `evaluate_script` 单程往返就要几秒到几十秒，定点轮询必然错过窗口 —— 要在触发前先在页面里装采样器（`setInterval` 记录 DOM 状态变化到 `window.__log__`），跑完再取。另外这类链路可以离线验证：用一个假 SSE 后端（按 Responses 事件顺序下发，可控静默时长）替掉真实上游，把 `VITE_API_BASE_URL` 指过去，既不消耗模型调用又能复现协议时序。
   - **内嵌 Browser 面板可能整段时间是 hidden**：`document.visibilityState === 'hidden'` 时 `requestAnimationFrame` **一帧都不发**，所以追滚、动画、任何 rAF 合帧的逻辑在面板里根本跑不出行为（`take_screenshot` 也会以 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` 失败）。要测这类代码就自启一个无头实例：`chrome.exe --headless=new --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir=<临时目录> http://localhost:5173/`，用 Node 内置 `WebSocket` 连 CDP `Runtime.evaluate`（`awaitPromise: true`），在页面里一次跑完"装钩子 → 驱动 UI → 逐帧采样 → 返回 JSON"。脚本放在 `node_modules/.scratch/`（`fake-llm.mjs` + `cdp-scroll-probe.mjs`；MCP 那批是 `fake-mcp-upstream.mjs` + `cdp-mcp-probe.mjs` + `fake_mcp_server.py` + `mcp_client_check.py` + `mcp_timeout_30s.py` + `mcp_real_smoke.py`），**`pnpm install` 会清掉**，重跑按本条描述重建。
   - 逐帧采样要同时记 `scrollHeight`/`clientHeight`：只看"脚本层写了几个值"证明不了观感，"离底部的滞后量 + 滞后帧占比"才是。
   - 换过一次组件源码再跑 A/B 时，`git show main:<file> > <file>` 可能被 vite 按 mtime 缓存成空模块，写完 `touch` 一下并 `curl` 该模块确认内容非空。
