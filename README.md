# AI Application

浏览器内 AI 应用生成平台：用户用自然语言描述需求，Agent 主循环在内存虚拟文件系统里生成前端代码，右侧 iframe 实时预览，支持多轮迭代修改。已支持多用户注册登录，会话与工作区按账号隔离。

面向 agent 的仓库说明（架构地图、编码约束、状态不变量、已知坑）见 [`AGENTS.md`](AGENTS.md)，那才是权威文档；本文只讲"这是什么、怎么跑起来"。

## 能做什么

- **对话生成应用**：Agent 主循环多轮 tool call，虚拟文件系统工具（write/read/edit/list/delete_file），生成结果边写边预览。
- **实时预览**：右侧 iframe `srcdoc` 渲染，沙箱为不透明源（生成的应用访问 `localStorage` 由注入的内存 shim 兜住），可在"预览 / 代码"两个视图间切换。
- **多会话**：侧边栏会话列表，重命名、拖拽排序、标题自动生成，消息与工作区落 SQLite，刷新不丢。
- **能力（capability）接入**：
  - **MCP 外部工具** —— 后端手搓的最小 MCP 客户端（Streamable HTTP + SSE），工具清单按需注册进 registry。
  - **技能（Skill）** —— 内置技能包 + 阿里云百炼技能库，`skill_search` / `skill_load` / `skill_file` 三个工具，正文按需注入上下文。
  - 两者都在界面上有独立开关面板（全局偏好，不属于任何一条会话）。
- **语音输入**：麦克风采集 + PCM 编码，走后端 WebSocket 代理 DashScope 实时 ASR。
- **Markdown 渲染**：回答与技能正文按 Markdown 渲染，代码块高亮。
- **账号与隔离**：注册/登录（scrypt 口令 + 服务端不透明 token），`/api/*` 全站鉴权，会话按 `user_id` 归属；改密即吊销全部 token。忘记密码只有站长本机跑脚本重置。
- **上下文预算**：先语义压缩再硬截断，保证 tool 调用配对不被截断打断。

## 技术栈

| 层 | 选型 |
|---|---|
| 前端 | React 19 + TypeScript + Vite + Ant Design 6 + Zustand 5 |
| 测试 | Vitest（130 用例，覆盖 agent / llm / store / preview / utils 纯逻辑） |
| 静态检查 | oxlint；`tsc -b` 参与构建 |
| 后端 | Python 3.10+ / FastAPI / uvicorn / httpx / websockets |
| 存储 | SQLite（WAL + 外键），服务端注入 LLM API key |

LLM 上游走 OpenAI Responses 流式协议（兼容 DashScope / DeepSeek 等），另有一个 Mock provider，无 key、断网也能跑通完整链路。

## 快速开始

需要 pnpm（workspace 根目录执行，`pnpm-lock.yaml` 已提交），Node 版本要求 `^20.19.0 || >=22.12.0`（vite 8 的 engines），以及 Python 3.10+。

```bash
# 1. 前端依赖
pnpm install

# 2. 后端依赖（Windows 下没有 pip 命令，用 python -m pip）
python -m pip install "fastapi>=0.115" "uvicorn[standard]>=0.34" httpx python-dotenv websockets

# 3. 配置：两份 .env 各自维护，值不要提交
cp packages/server/.env.example packages/server/.env    # LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
cp packages/web/.env.example packages/web/.env          # 同上 + VITE_API_BASE_URL=http://localhost:8000

# 4. 起后端（8000）
pnpm dev:server

# 5. 另开一个终端起前端（5173）
pnpm dev
```

打开 `http://localhost:5173/`，界面先是登录卡 —— 切到「注册」建一个账号（没有管理员之分，首个账号也不特殊），登录后左侧新建会话、中间描述需求、右侧看预览。

`VITE_API_BASE_URL` 必须非空并指向后端地址 —— 会话、LLM、技能、MCP、语音全走 FastAPI，API key 由服务端注入。改了这个值要重启 vite（它是启动时烘焙进模块的）。后端端口换成别的，除了同步改这个值，还要把 `packages/server/app/main.py` 的 CORS 白名单一起加上对应端口。

技能通道（可选）另需 `BAILIAN_WORKSPACE_ID`，复用同一把 `LLM_API_KEY`。不配时百炼那一路在界面上显示为"目录有 N 处异常"，内置技能照常用。

其他可选开关：`APP_DB_PATH` 把 SQLite 指到别的文件（验证脚本靠它，否则会把测试账号写进正式库）；`SPEND_DAILY_LIMIT` 是每日生成次数闸门，默认 `0` = 只记账不拦。

## 验证改动

```bash
pnpm --filter web test:run   # 前端单测，130 用例
pnpm --filter web lint       # oxlint
pnpm build                   # tsc -b && vite build
```

单测只覆盖纯逻辑，UI 交互没有自动化测试 —— 涉及交互的改动要在浏览器里实操验证。

找回密码（本机执行，刻意不做成 HTTP 接口）：

```bash
cd packages/server && python -m app.scripts.reset_password <username> <newpassword>
```

## 目录结构

```
packages/web/            前端（Vite + React）
  src/agent/             Agent 主循环、工具注册表、能力（MCP / 技能）provider、上下文预算
  src/llm/               provider 路由与流式协议实现（含 mock）
  src/store/             zustand 分片状态：chatStore / sessionStore / workspaceStore / authStore
  src/components/        界面：AuthGate / Workbench / Sidebar / ChatInterface / PreviewArea / 能力面板
  src/preview/           iframe srcdoc 构建
packages/server/         后端（FastAPI）
  app/routes/            auth / llm / sessions / mcp / skills / voice
  app/auth.py            scrypt 哈希 + 不透明 token
  app/mcp/               最小 MCP 客户端与已接入 server 配置
  app/skills/            内置技能包与百炼通道
  app/spend_log.py       按天生成次数记账（默认只记不拦）
docs/
  origin/                原始需求与外部输入（每日需求记 YY-M-D.md）
  SDD/                   每个特性一份轻量方案，含测试/评审报告
```

## 文档

- 设计与实现方案：[`docs/SDD/`](docs/SDD/)（按特性一份，如 `ai-app-gen-mvp`、`mcp-external-tools`、`agent-skills`、`multi-tenant-p0`）
- 每日需求记录：[`docs/origin/`](docs/origin/)
- Agent 工作约定与踩坑记录：[`AGENTS.md`](AGENTS.md)

## 已知限制

- 生产构建未做代码分割，主 chunk 约 1.0 MB / gzip 331 kB（antd + highlight.js）。
- 所有账号共用一把上游 API key，`SPEND_DAILY_LIMIT` 默认关闭，暂无按人限流。
- MCP server 与百炼 workspace 的配置写死在服务端，界面上不能增删。
- 语音识别依赖 DashScope 原生 WS 协议（复用 `LLM_API_KEY`），不是 OpenAI realtime；上游若换成非 DashScope 服务，语音那一路不通，其余功能不受影响。
- 无 key / 断网时把 `VITE_LLM_PROVIDER` 设成 `mock`，可用内置 Mock provider 跑通完整链路。
