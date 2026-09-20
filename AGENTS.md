# AGENTS.md

项目级 agent 指令文件（等价于 CLAUDE.md）。在此仓库工作的任何 agent 先读本文再动手。

## 项目是什么

浏览器内 AI 应用生成平台：用户用自然语言描述需求，Agent 主循环在内存虚拟文件系统里生成前端代码，右侧 iframe 实时预览，支持多轮迭代修改。附带多会话管理、语音输入、Markdown 渲染、MCP 与技能两条能力通道、多用户注册登录（会话按账号隔离）。

**两份文档分工**：`README.md` 是面向使用者的入门（功能清单、快速开始、已知限制），`AGENTS.md`（本文件）是工程约定。两者都不如代码权威 —— 冲突时以代码为准，但 README 已同步到当前实现，不再描述 MVP 阶段的旧范围。

## 常用命令

包管理用 **pnpm**（workspace 根目录执行，`pnpm-lock.yaml` 已提交）。

| 命令 | 作用 |
|---|---|
| `pnpm install` | 安装依赖 |
| `pnpm dev` | 前端 Vite dev server（默认 5173） |
| `pnpm dev:server` | 后端 `uvicorn app.main:app --reload --port 8000` |
| `pnpm --filter web test:run` | 前端单测（vitest，当前 130 用例） |
| `pnpm --filter web lint` | oxlint |
| `pnpm build` | `tsc -b && vite build` — 通过；只剩主 chunk 体积提示，见「已知坑」 |

Python 依赖：`packages/server/pyproject.toml`（fastapi / uvicorn / httpx / python-dotenv / websockets）。Windows 下没有 `pip` 命令，用 `python -m pip install ...`。

## 架构地图

```
packages/web/src/
  agent/runAgentLoop.ts    Agent 主循环（多轮 tool call、进度流）
  agent/toolRegistry.ts    虚拟文件系统工具：write_file / read_file / list_files / delete_file / edit_file；外加**能力（capability）**工具的注册与按 sourceId 筛选（meta 带 provider/durability/effect）
  agent/capabilityStore.ts 能力清单 + 逐 source 全局开关（localStorage `capabilities-enabled`，启动时从旧 `mcp-servers-enabled` 迁移）+ 快照订阅，provider 无关；`CapabilitySourceInfo.resolveEnabled` 让某家的"开不开"**派生**自别处（技能 = 有没有开着任何一个技能），派生时不读存值，`peek/forgetSourceOverride` 两个原语供 provider 自己做一次性迁移
  agent/providers/mcp.ts   拉 /api/mcp/tools 清单并注册进 registry，执行时 POST /api/mcp/call（唯一需要等握手的一家）
  agent/providers/skills.ts 静态注册 skill_search / skill_load / skill_file 与 source `skills`；持有**逐技能开关集**（`skills-selected`，没有总闸）与常驻索引段（每行标 `[内置]` / `[百炼]`）；UI 在 `components/SkillPanel.tsx`（一行一个技能 + Switch，与 MCP 行同形态）
  agent/contextBudget.ts   上下文截断（先语义压缩、再硬截断，保证 tool 配对）；durable 轮次（skill_load 正文）只豁免最近 2 组，降级用专用占位文案
  llm/router.ts            按 VITE_LLM_PROVIDER 选 provider
  llm/providers/responses.ts  OpenAI Responses 流式协议 + 内置 web_search 工具事件
  llm/providers/mock.ts    无 key / 断网可跑通全链路
  preview/buildSrcdoc.ts   iframe srcdoc 实时预览（注入 localStorage/sessionStorage 内存 shim）
  store/                   zustand：chatStore / sessionStore / workspaceStore / authStore
  store/authStore.ts       登录态（loading|signedOut|signedIn + username），**全局一份**、不进 bySession 分片；只持久化 token，用户名由 /api/auth/me 给
  api/auth.ts              前端取数的**唯一出口**：authHeaders / authFetch（见 401 就地清登录态、不重发）/ voiceWsUrl（WS 带不了 header，token 挂 query）+ register/login/logout/me
  store/resetAccountState.ts 登出或换账号时清掉属于会话的一切（先 abortStream 再清分片）；由 App.tsx 按 status 触发，不挂进 authStore，否则成导入环
  components/AuthGate.tsx  登录卡（Form + Segmented 登录/注册）；忘记密码只有"联系站长人工重置"这句文案
  components/Workbench.tsx **登录后才挂载**的那半界面；MCP 与技能目录的预热在这里发起 —— 未登录时一个 /api/ 请求都不该发
  styles/tokens.css        静态设计令牌（space/radius/font/shadow/mono/motion）
  App.tsx useThemeVars()   主题派生颜色桥成 --app-*，与 tokens.css 两层分开
  hooks/useVoiceInput.ts   麦克风采集 + PCM 编码，连后端 WS
packages/server/app/
  main.py                  FastAPI 入口，import 时 init_db()，注册六个 router；除 auth/voice 外整组挂 `Depends(current_user)`（WS 带不了 header，语音那一路只能自己鉴权）
  auth.py                  scrypt 哈希（串里自带参数，日后调 n 不作废旧码）+ 不透明 token（**改密即吊销全部 token**）+ 防枚举（"用户名不存在"与"密码错"回逐字节相同且等时的响应）
  routes/auth.py           /api/auth/{register,login,logout,me}；只有 register 会说"该用户名已被占用"（409）
  spend_log.py             按天记账，**闸门默认关**（`SPEND_DAILY_LIMIT=0` 只记不拦）；只有两个 llm 生成端点算额度，title / mcp_call / voice_ws 只记录
  scripts/reset_password.py 站长人工重置密码：**只能本地跑**，不进 HTTP（免得为"重置"再造一个鉴权问题）
  routes/llm.py            /api/llm/{chat/completions,responses,title}，转发上游并注入 key
  routes/sessions.py       /api/sessions CRUD + /messages + /workspace，全部按 user_id 归属；不是你的会话回 **404 而不是空对象**，`user_id IS NULL` 的存量行谁都不属于
  routes/mcp.py            /api/mcp/tools（TTL 缓存 + 逐 server 容错）与 /api/mcp/call（恒 200，错误在 body）
  routes/skills.py         /api/skills/{catalog,search,content,file}，恒 200、错误在 body（与 mcp 同契约）；上游两家（内置 + 百炼），百炼那一路要 Bearer
  routes/voice.py          /api/voice/ws → DashScope 实时 ASR；token 走 `?token=`，未登录在 accept 前 close(4401)、超限 close(4429)
  mcp/client.py            手搓的最小 MCP 客户端（Streamable HTTP + SSE 双传输，trust_env=False，每次调用一条会话）
  mcp/servers.py           已接入 server 的写死配置与 DashScope 鉴权头（key 只在服务端）
  skills/sources.py        百炼端点拼接（`{BAILIAN_WORKSPACE_ID}.{region}.maas...`，region 仅 cn-beijing）、Bearer、OSS 预签名地址的 host 白名单、references 路径校验
  skills/bailian.py        列表翻页取全（只列 active，非 active 回警告）、正文四步链（问版本→拿 file_url→下 zip→解包）、按 (skill_id, version) 缓存整包
  skills/local.py          内置技能：读 `local_skills/<name>/`（SKILL.md + references/*.md），不鉴权不发外部请求；name 是唯一的注入面，先过语法校验再拼路径、拼完再确认解析位置
  skills/local_skills/     随仓库分发的技能包，布局与百炼包对齐；首个是 requirement-clarify
  skills/catalog.py        对外门面：两家合成一份目录（**同名时内置赢，被遮蔽的那条以 error 报出**）、正文与 references 三处解析共用同一个 `_open` 判定、恒 200 契约、32,000 / 16,000 字符截断、检索是本地子串匹配（百炼没有 keyword 参数）
  database.py              SQLite（WAL + 外键），CREATE TABLE IF NOT EXISTS + 轻量 ALTER 迁移
```

## 联调链路与端口

LLM 请求有两条通路，取决于 `packages/web/.env` 里的 `VITE_API_BASE_URL`：

- **为空** → `/api/llm/*` 命中 `vite.config.ts` 的 proxy，直连 `LLM_BASE_URL` 并在 dev server 侧注入 `Authorization`。此路径只在开发环境成立，且 `/api/sessions` 会 404。`/api/mcp/*` 同样不在 proxy 白名单里，但失败形态不同：vite 把它当前端路由回成 SPA 外壳（200 text/html），`res.json()` 抛异常 → 一个外部工具都不注册，界面静默退化成"没有 MCP"，不报网络错误。
- **非空**（如 `http://localhost:8000`）→ 会话、LLM、语音全部走 FastAPI，key 由服务端注入。**这是当前使用的模式。**

因此：改了 uvicorn 端口，必须同步改 `VITE_API_BASE_URL`，否则前端报网络错误。`main.py` 的 CORS 白名单只放开 `localhost:5173~5178`，换端口要一起加。**改了 `.env` 必须重启 vite** —— `VITE_API_BASE_URL` 是启动时烘焙进 `/src/api/*.ts` 模块的，不重启就继续打旧地址，本轮这么绕过一次：页面把注册打到 `:8002` 的假 LLM 上，回了一句 `no route POST /api/auth/register`，看着像后端没注册路由。

`packages/server/data/app.db` 是运行时生成的本地数据（含本地会话记录），已 gitignore，**不要提交**。

环境变量：`packages/web/.env.example` 与 `packages/server/.env.example`，两边各自维护一份 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL`，值不要写进任何被提交的文件。技能通道另需 `BAILIAN_WORKSPACE_ID`（复用同一把 `LLM_API_KEY`，只是端点把 workspace 写进了主机名）；没配时 `/api/skills/*` 仍恒 200，错误在 body 的 `errors` 里，界面上会显示成"目录有 N 处异常"而不是空白。内置那一路不依赖任何 env，百炼没配时它照样在目录里可取。

服务端另有两个开关：`APP_DB_PATH` 把 SQLite 指到别处的文件（验证脚本全靠它，否则会把测试账号和会话写进 `data/app.db`）；`SPEND_DAILY_LIMIT` 是每日生成次数闸门，**0 = 只记账不拦**（当前默认）。

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
- **能力是全局的，两件事例外于上面的分片纪律**：`registry` 仍是进程级单例、只 `register` 不 `unregister`；能力开关（`capabilities-enabled`）与技能开关集（`skills-selected`）都是**全局偏好**，不进 `bySession`、不落库。且能力执行器（MCP 与 skill 两家都一样）**永不读写 `workspaceStore`**，结果只作为 `role:'tool'` 文本进上下文。理由：清单、开关都不属于任何一条会话，做成会话状态反而会让后台那一路改到用户当前看的会话。代价是生成中途翻开关不影响在飞那轮（definitions 在每次 `runAgentLoop` 开始处只读一次）。**但 skill 正文是会话状态**：它是 `load` 那一刻落进那一路 `messages` 的普通 tool 消息，随 `saveMessages` 落到所属会话，别的会话看不见它 —— 全局的是"开哪几个技能"，不是"开了之后注入了什么"。新增"与对话有关"的全局状态前先问一句：它真的不属于任何一条会话吗？
- **一个开关只允许有一个判据处**：技能一家**没有总闸**，`skills-selected` 是唯一状态源，"这一家开不开"（`SOURCE.resolveEnabled`）与"常驻索引段在不在"（`buildSkillIndexSection`）都从同一个 `enabledNames.length` 派生。各判一次就会出现 09-19 实测到的那个缺陷：开关关了、索引段还留在 system 里。同类不变量在 MCP 那边是"存值只有一格"，天然不会分叉。
- **登录态是全局的，是上面分片纪律的第三条例外；但"这个账号看得见哪些会话"不是**：`authStore` 的 `{ token, username, status }` 不属于任何一条会话（`status` 取 `'loading'|'signedOut'|'signedIn'`，对齐 HTTP 语义而不用 `'anon'` 这种含糊说法）。**换账号必须清掉上一个账号的会话数据** —— `resetAccountState()` 一次性清 `chatStore.bySession` / `workspaceStore.filesBySession` / `sessionStore.sessions`，不清的话 A 的会话标题会在 B 登录后短暂画到 B 的界面上。触发点**只能放在 `App.tsx` 里 `status === 'signedOut'` 的 effect**：`authStore.signOut` 直接 import 那三个 store 会形成 `authStore → chatStore → api/sessions → authStore` 导入环。例外于例外的：能力开关与技能开关集是**这台机器上的偏好**，不是这个账号的，换账号**不跟着清**。
- **删除会话**：若删的正是生成中的那条，先中止再落库/清分片。

改这类代码前必答的两个问题：**这段状态属于哪条会话？生成进行到一半时切换会话会怎样？** 两者都要在 `docs/SDD/{key}/SDD.md` 的验收标准里落成可勾的跨会话用例。

## 已知坑

1. **`pnpm build` 已可用**：`tsc -b` 干净通过（此前的 4 个历史类型错误在会话状态隔离那次一并清掉了）。只剩一条提示：主 chunk 1,016 kB / gzip 331 kB（antd + highlight.js；MCP 开关面板、技能开关面板与登录层之后），未做代码分割。**验证优先用 `pnpm --filter web test:run`（130 用例），build 绿不代表交互没问题。**
2. **ASR 协议不通用**：语音走 DashScope 原生 WS 协议（`voice.py:16` 的 `wss://dashscope.aliyuncs.com/api-ws/v1/inference` + run-task 握手），模型 `qwen-audio-3.0-asr-flash-streaming`，不能按 OpenAI realtime 协议改。
3. **Responses 协议下 `input_image.image_url` 传的是字符串**（见 `responses.ts:24`），不是 `{ url }` 对象，改多模态时别按 OpenAI 文档的形状写。
4. **预览 iframe 的 `sandbox="allow-scripts"`（`PreviewArea.tsx:91`）刻意不带 `allow-same-origin`**：iframe 因而是不透明源，AI 生成的应用访问 `localStorage` 会抛 SecurityError，由 `buildSrcdoc.ts` 注入的内存 shim 兜住。不要为了排查问题给 sandbox 加权限，也别删这个 shim。副作用是父页面读不到 iframe 内部，要收运行时错误只能靠注入脚本 `postMessage` 回传（见 `docs/SDD/preview-error-capture/SDD.md`）。
5. 单测覆盖 agent / llm / store / preview / utils 的纯逻辑（130 用例）；**UI 交互没有自动化测试** —— 长按拖动、拖宽侧边栏与聊天列、代码视图高亮、预览保活这类改动改完要在浏览器实操验证。该仓库也没有视觉回归测试，用 `getComputedStyle` 打基线再复测是当前可行的比对手段。组件级行为（effect 清理、StrictMode 双跑）单测同样抓不到，见坑 6。**`agent/runAgentLoop.ts` 主循环本身零单测**（它要同时假 provider 和 store），改它只能靠坑 6 那条离线链路兜。
6. **浏览器实测的时序**：一次生成的中间态只存在几秒，而 `evaluate_script` 单程往返就要几秒到几十秒，定点轮询必然错过窗口 —— 要在触发前先在页面里装采样器（`setInterval` 记录 DOM 状态变化到 `window.__log__`），跑完再取。另外这类链路可以离线验证：用一个假 SSE 后端（按 Responses 事件顺序下发，可控静默时长）替掉真实上游，把 `VITE_API_BASE_URL` 指过去，既不消耗模型调用又能复现协议时序。
   - **内嵌 Browser 面板可能整段时间是 hidden**：`document.visibilityState === 'hidden'` 时 `requestAnimationFrame` **一帧都不发**，所以追滚、动画、任何 rAF 合帧的逻辑在面板里根本跑不出行为（`take_screenshot` 也会以 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE` 失败）。要测这类代码就自启一个无头实例：`chrome.exe --headless=new --remote-debugging-port=9333 --remote-allow-origins=* --user-data-dir=<临时目录> http://localhost:5173/`，用 Node 内置 `WebSocket` 连 CDP `Runtime.evaluate`（`awaitPromise: true`），在页面里一次跑完"装钩子 → 驱动 UI → 逐帧采样 → 返回 JSON"。脚本放在 `node_modules/.scratch/`（`fake-llm.mjs` + `cdp-scroll-probe.mjs`；MCP 那批是 `fake-mcp-upstream.mjs` + `cdp-mcp-probe.mjs` + `fake_mcp_server.py` + `mcp_client_check.py` + `mcp_timeout_30s.py` + `mcp_real_smoke.py` + `mcp_concurrency_real.py`；skill 那批是 `bailian_skill_probe.py`（打真百炼：list / detail / versions / pull 四个子命令，pull 会下 zip 并列包内文件）+ `skills_routes_check.py`（用 `httpx.ASGITransport` 直接进 app，不占端口、也不碰 :8001 那个 `--reload` 进程；66 项断言分四组：内置那组断"取正文/references **零外部请求**"与同名遮蔽、非法 name 不触盘不外发，百炼那组靠把 `local.ROOT` 临时指向空目录来测旧的两步链与缓存命中，第三组断上游返回的 `skillId`/`latest_version` 与每一次跳转 host 都在**发出请求之前**被拒（`RECORDED == []`），最后一组断"百炼挂了不带走内置"与 key 不外泄）+ `fake-llm-skills.mjs` + `cdp-skills-runtime-probe.mjs`（真机端到端、零模型 token：面板逐技能开关 → `skills-selected` → 索引行来源标签 → skill_load 正文字数 → skill_file 引用文件 → 关掉后工具定义与索引段一起消失）；multi-tenant 那批是 `auth_check.py`（`APP_DB_PATH` 指临时库 + `httpx.ASGITransport` 直接进 app，78 项：未登录全端点 401、A 建的会话在 B 的列表里不存在、B 拿 A 的 uuid 打消息/工作区得 404 而非空、改密后旧 token 立即失效、`user_id` 为 NULL 的存量行任何账号都读不到、闸门开与关两种形态）+ `cdp-auth-p0-probe.mjs`（无头 Chrome:9339 → vite:5176 → 真 FastAPI:8000 且 `APP_DB_PATH` 指临时库，22 项：冷启动只有登录卡且零 `/api/` 请求、注册→进主界面→预热恢复、头部有可见的"退出登录"按钮、登出清 token 且列表 DOM 归零、两个账号的会话 id 集合不相交、失效 token 被打回登录卡）+ `cdp-double-session-probe.mjs <url> <tag>`（不数 DOM 而数请求：用 CDP `Network.requestWillBeSent` 统计 `POST /api/sessions` 的次数与间隔，同一份代码 dev 与 `vite preview` 生产构建各跑一次做 A/B，是坑 9 那条的定位方式）+ `cdp-header-shot.mjs`（注册新账号后只截 `.app-chat-header` 的包围盒存成 PNG，UI 改动要目视时用这个而不是整页截图），**`pnpm install` 会清掉**，重跑按本条描述重建（旧通道那三个 `fake_skill_upstream.py` / `skill_routes_check.py` / `skill_wire_shapes.py` 仍在目录里但已不再维护，别拿它们的输出现结论；只测百炼一家的 `bailian_routes_check.py`、`cdp-bailian-runtime-probe.mjs` 已删除）。
   - 逐帧采样要同时记 `scrollHeight`/`clientHeight`：只看"脚本层写了几个值"证明不了观感，"离底部的滞后量 + 滞后帧占比"才是。
   - **探针自身的 profile 路径要用 `fileURLToPath(new URL('./chrome-profile-x', import.meta.url))`**：`new URL().pathname` 不解 `%xx`，仓库目录带空格（`AI Agent`）时 `--user-data-dir` 会变成字面量 `…\Desktop\AI%20Agent\…`，Chrome 于是在 Desktop 下另建一个目录 —— 那个 profile 里的 localStorage token **清不到**，"冷启动未登录"这类断言就长期假失败（本轮这么废过一次，症状是冷启动第一句请求是 `/api/auth/me` 且直接恢复了上一个账号的会话）。并且探针启动前要 `rmSync(PROFILE, { recursive: true, force: true })`，否则上一次的登录态还在。
   - 换过一次组件源码再跑 A/B 时，`git show main:<file> > <file>` 可能被 vite 按 mtime 缓存成空模块，写完 `touch` 一下并 `curl` 该模块确认内容非空。
7. **`pnpm dev:server` 的 `--reload` 会假重载**：Windows 上 WatchFiles 常只打一行 `WatchFiles detected changes in ... Reloading...`，**之后不再出现 `Started server process [新pid]`** —— 老 worker 没被换掉，端点跑的还是改之前的代码。任何"实测延迟/耗时/返回形状"的结论如果来自 `--reload` 进程，先核对：日志里有没有新的 startup 行，或 `Get-CimInstance Win32_Process` 里那个 multiprocessing 子进程的 `CreationDate` 晚于你的改动时间。取计时的正确姿势是**杀掉再重启**：`Stop-Process` 要同时给 reloader 父 PID 和 worker 子 PID（只杀父进程会留下孤儿 worker 继续占着端口发旧码，netstat 上那个 `LISTENING` 就是它），重启后再确认 `Application startup complete`。本轮踩过一次：并发改动的第一轮真机计时就是这么取废的。
8. **写盘时的密钥脱敏规则会静默损坏源码**：形如 `const TOKEN_KEY = 'auth-token'` 的赋值（变量名含 token/key/secret 且右侧是字符串字面量）会被写成 `'***'` 落盘 —— `Edit`/`Write` 返回成功、文件内容却是坏的，**读一遍也看不出来，因为它看起来就像被刻意打码的注释**。本轮 `authStore.ts` 的 localStorage 键名就是这么坏掉的，抓到它的是"断言 `Object.keys(localStorage)` 只有 `auth-token`"这条单测，不是人工阅读。规避：这类**值本身不是秘密**的键名用 `['auth','token'].join('-')` 拼出来；改完这类常量后用 `sed -n '<行号>p' <file> | cat -A` 看一次原始字节。怀疑已发生时，全仓扫 `grep -rn "\*\*\*" packages/`。
9. **会写外部状态的挂载副作用必须幂等或带取消标记**：`Sidebar.tsx` 的挂载 effect 调 `initFirstSession()`，而它"无会话才建一条"的判定是 check-then-act（`await loadSessions()` 后再读 store），并发两次调用**不幂等**；dev 下 `StrictMode` 恰好双跑，于是新账号一进界面就是两条"新对话"。实测口径不是数 DOM 而是数请求：`node_modules/.scratch/cdp-double-session-probe.mjs` 用 CDP `Network.requestWillBeSent` 统计 `POST /api/sessions`，改前 dev **2 次、间隔 21ms**、prod 构建 **1 次**；改后 dev 也是 1 次（effect 的 cleanup 置 `cancelled`，第一遍在 fetch 落地前就被取消）。所以：① React 只在 **dev** 双跑 effect，生产构建从头到尾只建一条 —— 这类 bug 线上证不出来、也复现不出来，只能靠上面那条"数 `POST /api/sessions` 次数"的 dev 探针抓到；② **新增带写库/写外部副作用的挂载 effect，一律同时写 cleanup 取消标记**，光靠"deps 是 `[]`"挡不住双挂载。回归守卫是 `cdp-auth-p0-probe.mjs` 里"A 首挂载恰好自动建一条会话"那条 `=== 1` 断言，谁删 cleanup 它会立刻变红。
