# 慧应用 MVP-6：会话管理 - SDD

## 需求

当前 chatStore 的 messages 是纯内存状态，刷新页面即丢失。MVP-6 实现多会话持久化：用户可以新建、切换、删除会话，消息历史存到服务端 SQLite，刷新/换设备不丢数据。

**只做**：SQLite 数据模型 + FastAPI CRUD API + 前端 sessionStore + chatStore 改造 + 会话列表 UI。**不做**：用户认证（单用户模式）、消息搜索、会话导出、WebSocket 实时同步。

## 关键设计决策

### 数据模型

```sql
-- 会话表
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,          -- UUID v4
    title TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL,     -- ISO 8601
    updated_at TEXT NOT NULL      -- ISO 8601，每次消息更新时刷新
);

-- 消息表
CREATE TABLE messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,           -- user | assistant | system | tool
    content TEXT NOT NULL DEFAULT '',
    tool_calls TEXT,              -- JSON array of ToolCall，nullable
    tool_call_id TEXT,            -- nullable，role=tool 时使用
    reasoning TEXT,               -- nullable，assistant 思考过程
    created_at TEXT NOT NULL      -- ISO 8601
);

CREATE INDEX idx_messages_session ON messages(session_id, id);
```

**为什么这样设计**：
- `sessions.id` 用 UUID 而非自增 ID：前端可预生成 ID 再发消息，避免创建-发送两步操作的竞态
- `messages.tool_calls` 存 JSON 字符串而非关联表：ToolCall 结构固定且总是整体读写，JSON 列查询性能足够（消息量级 <10万）
- `ON DELETE CASCADE`：删会话自动清消息，无需手动事务
- `updated_at` 冗余字段：会话列表按最近活跃排序时避免 JOIN messages 表

### API 端点

| Method | Path | Body | Response | 说明 |
|--------|------|------|----------|------|
| GET | `/api/sessions` | - | `{sessions: Session[]}` | 按 updated_at DESC 排序 |
| POST | `/api/sessions` | `{title?: string}` | `Session` | 创建新会话，返回完整对象 |
| PATCH | `/api/sessions/:id` | `{title?: string}` | `Session` | 更新标题 |
| DELETE | `/api/sessions/:id` | - | `{ok: true}` | 级联删除消息 |
| GET | `/api/sessions/:id/messages` | - | `{messages: Message[]}` | 按 id ASC 排序 |
| POST | `/api/sessions/:id/messages` | `Message[]` | `{count: number}` | 批量追加消息（agent loop 结束后一次性写入） |
| GET | `/api/sessions/:id/workspace` | - | `{files: Record<string, string>}` | 获取该会话的工作区文件 |
| PUT | `/api/sessions/:id/workspace` | `{files: Record<string, string>}` | `{ok: true}` | 全量覆盖工作区文件（agent loop 结束后同步） |

**为什么批量写入而非逐条**：
- agent loop 一轮可能产生 3-5 条消息（assistant + tool_calls + tool results），逐条写入 = 3-5 次 HTTP + DB roundtrip
- 批量写入一次事务完成，延迟从 ~150ms 降到 ~30ms
- 前端在 `runAgentLoop` 完成后才调用 POST，不影响流式体验

### 前端架构

新增 `sessionStore.ts`（Zustand），chatStore 改为依赖 sessionStore：

```ts
// sessionStore.ts
interface SessionState {
  sessions: Session[]
  currentSessionId: string | null
  loadSessions: () => Promise<void>
  createSession: () => Promise<string>
  switchSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  renameSession: (id: string, title: string) => Promise<void>
}

// chatStore.ts 改造
// - sendMessage 末尾：POST /api/sessions/:id/messages 持久化本轮新增消息
// - switchSession 时：GET /api/sessions/:id/messages 加载历史
// - 首次进入：若无会话则自动创建一个
```

### 会话列表 UI

左侧独立侧边栏（宽 240px，可折叠）：
- 顶部 "+" 按钮新建会话
- 会话列表按 updated_at DESC 排序，每项显示标题 + 相对时间（如"3分钟前"）
- 点击切换会话（加载该会话消息 + workspace 文件）
- hover 显示重命名/删除图标
- 当前活跃会话高亮

### workspace 与会话的关系

**一个 session = 一个 workspace**。workspaceStore 改为按 sessionId 隔离：

```ts
// workspaceStore.ts 改造
interface WorkspaceState {
  filesBySession: Record<string, Record<string, string>>  // sessionId → {path → content}
  currentSessionId: string | null
  getFile: (path: string) => string | undefined
  writeFile: (path: string, content: string) => void
  deleteFile: (path: string) => void
  listFiles: () => string[]
  setCurrentSession: (sessionId: string) => void
  loadWorkspace: (sessionId: string, files: Record<string, string>) => void
}
```

- 工具调用（write_file/read_file/list_files/delete_file）操作 `filesBySession[currentSessionId]`
- `buildSrcdoc` 从当前 session 的 files 构建预览
- 切换会话时：sessionStore.switchSession → workspaceStore.setCurrentSession + loadWorkspace
- 服务端新增 `/api/sessions/:id/workspace` GET/PUT 端点持久化文件
- 首次创建会话时 workspace 为空对象 `{}`

## 实现步骤

1. **Server: 数据库初始化**
   - `packages/server/app/database.py`：sqlite3 连接 + 建表脚本（sessions + messages + workspaces）
   - `main.py` 启动时执行 init_db()

2. **Server: Session CRUD + Workspace**
   - `packages/server/app/routes/sessions.py`：8 个端点（含 workspace GET/PUT）
   - Pydantic models：SessionCreate, SessionUpdate, SessionResponse, MessageCreate, WorkspaceUpdate

3. **Frontend: sessionStore**
   - `packages/web/src/store/sessionStore.ts`：Zustand store + fetch 封装
   - `packages/web/src/api/sessions.ts`：API client 函数

4. **Frontend: workspaceStore 改造**
   - filesBySession 按 sessionId 隔离
   - setCurrentSession / loadWorkspace 方法
   - 工具注册表无需改动（已通过 useWorkspaceStore.getState() 访问）

5. **Frontend: chatStore 改造**
   - sendMessage 末尾持久化新增消息 + 同步 workspace
   - 新增 loadSession(id) 方法（加载 messages + workspace）
   - 首次加载时若无会话则自动创建

6. **Frontend: 侧边栏 UI**
   - `packages/web/src/components/Sidebar.tsx`：会话列表 + 新建/重命名/删除
   - App.tsx 布局改为三栏（sidebar + chat + preview）

7. **验证**
   - Server pytest
   - Frontend Vitest
   - E2E：创建会话 → 生成应用 → 新建第二个会话 → 切回第一个 → 消息+预览完整恢复

## 验收标准

- [ ] 创建新会话后，会话列表立即显示
- [ ] 发送消息后刷新页面，消息历史完整恢复（含 tool_calls/reasoning）
- [ ] 切换会话时消息列表正确加载，无闪烁
- [ ] 删除会话后列表更新，当前会话自动切到其他会话
- [ ] 重命名会话后标题即时更新
- [ ] Server pytest 全过，Frontend Vitest 全过
- [ ] 类型检查通过
