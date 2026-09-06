# MVP-1：LLM Proxy Server（Python）- SDD

## 需求

MVP-0 的 LLM 调用依赖 Vite dev proxy，只在开发环境有效。MVP-1 补一个**生产可用的后端 LLM proxy**，使前端代码零改动即可从 dev 切到 prod。

**只做**：`packages/server` 用 Python（FastAPI）实现最小 LLM proxy，暴露 `POST /api/llm/chat/completions`，服务端读环境变量注入 API key，透传 SSE 流到前端。

**不做**：Agent 循环、虚拟 FS、预览、MCP、BaaS、数据库、认证鉴权。这些是后续迭代的事。

前端唯一改动：生产环境下请求目标从 Vite proxy 改为 server 地址（通过环境变量 `VITE_API_BASE_URL` 控制）。Provider 代码完全不动。

## 实现步骤

### 阶段 0：Server 脚手架

- `packages/server/pyproject.toml`：依赖 `fastapi` + `uvicorn[standard]` + `httpx`（异步 HTTP client，支持 SSE 透传）
- `packages/server/.env.example`：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（与 web 包同名变量，方便统一管理）
- `packages/server/app/__init__.py`：空文件
- `packages/server/app/main.py`：FastAPI app 入口
- `packages/server/app/config.py`：从环境变量 / `.env` 读取配置（用 `pydantic-settings` 或手动 `os.environ`）
- 根 `package.json` scripts 追加 `"dev:server": "cd packages/server && uvicorn app.main:app --reload --port 8000"`

### 阶段 1：LLM Proxy Endpoint

- `packages/server/app/routes/llm.py`：
  - `POST /api/llm/chat/completions`
  - 接收前端原始请求体（model / messages / stream 等），**不解析不校验**，直接透传
  - 用 `httpx.AsyncClient` 向 `LLM_BASE_URL/chat/completions` 发 POST，注入 `Authorization: Bearer <LLM_API_KEY>` header
  - `stream=true` 时：用 `httpx` 的 async streaming response，逐 chunk 透传给前端（`StreamingResponse(media_type="text/event-stream")`）
  - `stream=false` 时：等待完整响应后 JSONResponse 返回
  - 错误处理：上游返回非 2xx → 透传 status code + body；网络异常 → 502 + 错误信息
- `packages/server/app/main.py`：挂载 llm router，加 CORS middleware（允许 localhost:5173）

### 阶段 2：前端适配

- `packages/web/.env.example` 追加 `VITE_API_BASE_URL=http://localhost:8000`
- `packages/web/src/llm/providers/openai.ts`：fetch URL 从硬编码 `/api/llm/chat/completions` 改为 `${import.meta.env.VITE_API_BASE_URL || ''}/api/llm/chat/completions`
  - dev 环境 `VITE_API_BASE_URL` 为空 → 走相对路径 → Vite proxy 接管（向后兼容）
  - prod 环境设为 server 地址 → 直连后端
- 无其他前端改动

### 阶段 3：验收

- 启动 server（`uvicorn`）+ web（`vite dev`），发消息看到流式回复
- 停掉 Vite dev server，只跑 server + 静态 build 产物，仍能正常对话
- server 日志确认 key 只在服务端使用，前端请求不含 Authorization header
- 构建产物 grep 确认无 API key

## 验收标准

- [ ] `pnpm dev:server` 启动后，`curl -X POST http://localhost:8000/api/llm/chat/completions` 返回 SSE 流
- [ ] web dev 模式下（Vite proxy）和 prod 模式下（直连 server）都能正常流式对话
- [ ] server 进程内存中有 API key，但前端网络请求中不含 key（浏览器 DevTools Network 面板验证）
- [ ] 上游 LLM 不可达时，server 返回 502 + 可读错误信息，前端不崩溃
- [ ] `packages/server/` 含 `pyproject.toml` + `app/main.py` + `app/routes/llm.py`，结构清晰
- [ ] 前端 `openai.ts` 仅改了一行 fetch URL，provider 逻辑零改动
