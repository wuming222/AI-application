# @ai-app/server

后端包（Python 3.10+ / FastAPI）。启动方式见根目录 [`README.md`](../../README.md)，工程约定与踩坑见 [`AGENTS.md`](../../AGENTS.md)。

```bash
# workspace 根目录
pnpm dev:server        # uvicorn app.main:app --reload --port 8000
```

`--reload` 在 Windows 上会"假重载"（只打一行 Reloading 却不换 worker）；取任何计时结论前先核对日志里有没有新的 startup 行 —— 见 AGENTS.md 已知坑 7。

## 职责

- `/api/auth/*` —— 注册 / 登录 / 登出 / me；scrypt 口令 + 服务端存的不透明 token，改密即吊销全部 token。
- `/api/llm/*` —— 转发上游并注入 API key（chat/completions、responses、title）。
- `/api/sessions*` —— 会话、消息、工作区 CRUD，全部按 `user_id` 归属。
- `/api/mcp/*` —— 手搓的最小 MCP 客户端（Streamable HTTP + SSE 双传输）。
- `/api/skills/*` —— 技能通道的两家来源（内置包 + 阿里云百炼）。
- `/api/voice/ws` —— DashScope 实时 ASR 代理；WS 带不了 header，token 走 `?token=`。

除 `auth` 与 `voice` 外，整组 router 挂 `Depends(current_user)`。找回密码不做成接口，是本机执行的 `app.scripts.reset_password`。

## 存储与配置

SQLite（WAL + 外键），文件在 `data/app.db`，运行时生成、已 gitignore，**不要提交**。建表用 `CREATE TABLE IF NOT EXISTS` + 轻量 `ALTER` 迁移，无 ORM。

环境变量见 [`.env.example`](.env.example)：`LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 是上游三件套；`BAILIAN_WORKSPACE_ID`（+ 可选 `BAILIAN_REGION`）开技能通道，复用同一把 `LLM_API_KEY`；`APP_DB_PATH` 把库指到别的文件（验证脚本全靠它）；`SPEND_DAILY_LIMIT` 是每日生成次数闸门，默认 `0` = 只记账不拦。
