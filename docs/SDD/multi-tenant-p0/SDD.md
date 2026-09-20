# 多租户 P0：注册必选 + 数据归属 + 花费记账 - SDD

需求来源：`docs/origin/26-9-20.md` 第 11 节（当天三次收敛后的最终形态）。

## 需求

定位改成"别人能注册进来用的服务"，而当前三张表（`sessions` / `messages` / `workspaces`）零用户维度、全部 `/api/*` 端点无任何鉴权 —— 任何人拿到 session uuid 就能读走整段对话与代码，注册进来的人还能自由花那把共享 LLM key。

这一轮要的是：**身份必须真实（注册才能用），归属必须现在落地（`user_id` 后补会永久丢存量行的归属），花费只记账不拦截**（调试期，闸门唯一会挡住的人是用户自己，但"以后要在 5 个地方各插一次判断"才是重构，所以接缝这次留出来）。找回走人工：一个只能本地跑的改密脚本，不接邮件短信、不做恢复码。

## 实测基线（写码前逐条核过）

- 服务端文件：`app/` 下只有 `config.py`、`database.py`、`main.py`、`mcp/`、`routes/{llm,mcp,sessions,skills,voice}.py`、`skills/`。**没有** `auth.py`、`cache.py`、`schemas.py`、`scripts/`。
- `database.py`：`get_connection()`（:7）每次新开连接、无参；`init_db()`（:16）用 `executescript` 建三表，尾部已有 `try: ALTER … except OperationalError: pass` 的轻量迁移形状（:45-48）。`DB_PATH` 是模块级常量（:4），**测试要能换库得先让它可覆盖**。
- `sessions.py`：8 个端点、**14 条** `conn.execute`。要加归属的 9 条：`:43` 列表 SELECT、`:54` 插会话、`:70` 改标题、`:78` 回读、`:89` 删除、`:129` 存在性校验、`:142` 触 `updated_at`、`:166` 存在性校验、`:177` 触 `updated_at`。要新加 owner 校验的 2 条跨表读：`:100` 消息 SELECT、`:154` 工作区 SELECT（现在连会话存在性都不验）。经继承不用改的 3 条：`:58`、`:137`、`:172`。
- 花钱的 5 个入口：`llm.py:55`（chat/completions）、`:61`（responses）、`:71`（title）、`voice.py:19`（WS → DashScope ASR）、`mcp.py:77`（/call）。
- 前端网络调用点共 **6 处 fetch + 1 处 WebSocket**，各自持有自己的 `BASE` 常量：`api/sessions.ts:13`、`llm/providers/responses.ts:93`、`agent/providers/mcp.ts:28` 与 `:62`、`agent/providers/skills.ts:145`、`hooks/useVoiceInput.ts:98-100`。
- `api/sessions.ts:13-16` 的写法是 `headers: {...}, ...options` —— 调用方一旦传 `headers` 会**整个替换**而不是合并，加鉴权头时这是个必踩的坑。
- `main.py:17` CORS 已放开 `localhost:5173~5178` 与 `127.0.0.1:5173`；浏览器 WebSocket **不能带自定义 header**，所以语音那一路只能用 query 传 token。
- Python 3.12.6，`hashlib.scrypt` 可用（stdlib），环境**没有 pytest**、`packages/server` 也没有 `tests/` —— 服务端断言沿用 AGENTS.md 坑 6 的 `httpx.ASGITransport` 直进 app 的脚本形态，不新增运行期依赖。

## 实现步骤

### 一、服务端身份层（新增 3 个文件）

1. `app/database.py`：`DB_PATH` 改为读 `APP_DB_PATH` 环境变量（默认值不变，仅为了测试可换临时库）；`init_db()` 里新增两张表 + 一次 `ALTER`：
   - `users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, created_at TEXT NOT NULL)`
   - `auth_tokens(token TEXT PRIMARY KEY REFERENCES users(id) … )` → 实际写 `(token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL, expires_at TEXT NOT NULL)`
   - `sessions` 加 `user_id TEXT`（沿用 try/except OperationalError）。存量行归属为 `NULL` = **谁都不属于**，任何账号都看不到（不是"归第一个登录的人"）。本地开发库里的旧数据会因此从界面上消失，可接受，需要时删 `data/app.db` 重跑。
2. `app/auth.py`（新）：
   - `hash_password` / `verify_password`：`hashlib.scrypt`，参数 `n=2**14, r=8, p=1`，16 字节随机盐，串形如 `scrypt$n$r$p$<salt_hex>$<hash_hex>`；verify 先解析串里的参数再算，**不读全局配置**（否则改参数会让存量密码失效），比对用 `hmac.compare_digest`。
   - `issue_token(uid)` / `user_id_from_token(token)` / `revoke_all_tokens(uid)`；token = `secrets.token_urlsafe(32)`，原文入库（本机文件级 DB，MVP 可接受），**注释写明：迁到远端数据库前先改成存 hash**。默认有效期 30 天。
   - `require_user` / `current_user` 两个 FastAPI 依赖：从 `Authorization: Bearer` 取；**语音 WS 那一路从 query `?token=` 取**（浏览器限制，见基线）。取不到 / 过期 / 用户不存在 → 401，`detail` 只有一句"未登录或登录已过期"，不带任何原因分支。
   - 用户名规则：1–32 字符、`[A-Za-z0-9_\-\u4e00-\u9fa5]+`（放中文，长度收紧即可）；密码 8–72 字节。校验只在边界做，不做密码强度打分。
3. `app/routes/auth.py`（新）：`register` / `login` / `logout` / `me` 四个端点。
   - **防枚举**：`login` 的"用户名不存在"与"密码不对"**返回完全一致的响应体**（同 status、同 detail）；`用户名已被占用` 只允许出现在 `register`。
   - `register` 成功即直接发 token（省一步，也让"注册必选"在交互上是一次点击）。
4. `app/scripts/reset_password.py`（新）：`python -m app.scripts.reset_password <username> <newpassword>`，改 hash 并 `revoke_all_tokens`。刻意**不走 HTTP**：做成接口就得给接口本身做鉴权，而文件权限已经是那道验证。找不到用户时退出码非 0 并**不区分"用户不存在"与"密码非法"**（本地脚本，枚举风险为零，但保持与线上一致的措辞）。

### 二、鉴权收口（改 5 个已有 router）

规则一条，不留例外：**`/api/*` 全都要登录，只有 `/api/auth/register` 与 `/api/auth/login` 不要。**

- `sessions.py`：8 个端点逐个注入 `current_user`，按基线清单在 9 条语句上加 `AND user_id = ?` / 补 `user_id` 列，`:100` 与 `:154` 两处先过共用助手 `_owned_session(conn, sid, uid)` 再读。`PATCH`/`DELETE` 已把 `rowcount == 0` 当 404 抛，加条件后自动得到"别人的会话 = 404"，不泄露存在性。
- `llm.py` 3 个、`mcp.py` 的 `/call`（`/tools` 同规则一并要登录）、`skills.py` 4 个、`voice.py` WS：加 `Depends(require_user)`。
- **不做**：角色、权限分级、管理员面板。

### 三、花费记账接缝（只记账）

`app/spend_log.py`（新）：`record(user_id, entry) -> None`。内存计数 `{(uid, date): count}`，5 个入口各一行 `record(...)`；`SPEND_DAILY_LIMIT` 环境变量**默认 0 = 不限**，>0 才返回 429 且**只拒超限那一个账号**。落库先不做（重启清零在当前阶段无害），但 `record` 的签名里留好 `entry` 名字，将来加表不动调用点。

### 四、前端登录层

1. `src/store/authStore.ts`（新，zustand）：`{ token, username, status: 'loading'|'anon'|'ready' }`，token 存 localStorage key `auth-token`，**包 try/catch**（隐私模式会抛）。启动时 `status='loading'`，拿本地 token 打一次 `/api/auth/me` 决定 `anon` 还是 `ready`。
2. `src/api/auth.ts`（新）：`register` / `login` / `logout` / `me` 四个调用 + **一个 `authFetch(url, init)`**：加 `Authorization` 头、合并而不是覆盖调用方的 `headers`、**收到 401 就清本地 token 并回到登录态**。6 个 fetch 点和语音 WS 的 url 构造全部改走它（语音在 url 上拼 `?token=`）。
3. `App.tsx`：包一层 `<AuthGate>`。未登录只渲染居中的一张登录/卡（antd `Form` + `Segmented` 切登录/注册），登录后才渲染现有 `<Layout>`。**现有 `useEffect` 里那两个预热（`loadMcpCapabilities()` / `void loadSkillCatalog()`）必须挪到登录后才挂载的子组件里** —— 否则未登录时它们会全部 401（`loadSkillCatalog` 已带失败兜底，界面会显示"目录有 N 处异常"这种无意义提示）。
4. 会话列表的跨账号脏数据：切账号（登录成功、登出）时**必须清 `sessionStore` 的列表与 `chatStore.bySession`**，否则上一个账号的标题会短暂留在新账号的界面上。

### 五、验证

1. 服务端脚本 `node_modules/.scratch/auth_check.py`（`APP_DB_PATH` 指临时库 + `httpx.ASGITransport`，不占端口、不碰 `--reload` 进程）：断言 ① 未登录全端点 401；② A 建的会话在 B 的列表里没有；③ B 拿 A 的 uuid 打 `/messages` 与 `/workspace` 都得 **404 而不是空对象**；④ 登录两支响应体逐字节相同；⑤ 改密后旧 token 立即失效；⑥ `user_id` 为 NULL 的存量行任何账号都读不到；⑦ `SPEND_DAILY_LIMIT` 开与关各自的形态；⑧ 密码串能解析且 verify 拒绝畸形串。
2. 前端 vitest：`authStore` 的 try/catch 与状态机、`authFetch` 加头/合并头/401 清理、登出清分片。跑 `pnpm --filter web test:run`（基线 116 用例，本轮 +14 = 130）与 `pnpm build`。
3. 手工在浏览器验一次两个账号互不可见（UI 没有自动化覆盖）。

### 六、验证结果（2026-09-20 实跑）

| 项 | 命令 | 结果 |
|---|---|---|
| 服务端契约 | `python node_modules/.scratch/auth_check.py` | **ALL PASS（78 项）**，9 组；限额那一组用子进程带 `SPEND_DAILY_LIMIT=2` 复跑，形如 `[502,502,429,429]` 且别的账号不受牵连 |
| 前端单测 | `pnpm --filter web test:run` | **130 passed（16 文件）**，本轮新增 `authStore.test.ts`(11) + `resetAccountState.test.ts`(3) |
| 类型与产物 | `pnpm build` / `pnpm --filter web lint` | tsc 干净通过；只剩主 chunk 体积提示；oxlint 1 条告警是 `Sidebar.tsx:163` 的既有 exhaustive-deps |
| 真机端到端 | `node node_modules/.scratch/cdp-auth-p0-probe.mjs` | **ALL PASS（22 项）**，无头 Chrome → vite:5176 → 真实 FastAPI:8000（`APP_DB_PATH` 指临时库），零模型 token；含"头部有可见的退出登录按钮" |
| UI 目视 | `node node_modules/.scratch/cdp-header-shot.mjs` | 注册新账号后只截头部那条，产出 `node_modules/.scratch/header-shot.png`：标题靠左、用户名标签 + 带图标的"退出登录"按钮靠右 |

实现与设计的四处偏差（都不是设计变更）：

1. `authStore.status` 用 `'loading' | 'signedOut' | 'signedIn'`，没照第三节写的 `anon|ready` 命名 —— 界面上要区分"还没握过手"和"确认没登录"，后者才渲染登录卡。
2. `initFirstSession` / `loadSessions` 留在 `Sidebar` 里没上移：`Sidebar` 已经只在登录后挂载，效果与计划一致。
3. 登出清态写在 `store/resetAccountState.ts` 并由 `App.tsx` 按 `status==='signedOut'` 触发，没挂进 `authStore.signOut` —— 那边会形成 `authStore → chatStore → api/sessions → authStore` 的导入环。
4. 退出入口：第一版把登出做成"用户名本身是一颗 `type="text"` 的 Button"，看着就是个标签，等于没有入口。现在用户名退回纯文本标签，右侧独立一颗带 `LogoutOutlined` 的"退出登录"`Button`（`Workbench.tsx:75` 的 `.app-chat-account` 一组），Tooltip 说明"只清本地已加载数据、服务端记录不受影响"。探针新增一条断言守这颗按钮可见。

实测顺带钉住的两个事实：

- **vite 进程必须重启才吃新的 `.env`**。第一次跑真机探针时所有请求都打到 `:8002` 的假 LLM 上（那个进程还在回 `no route POST /api/auth/register`），因为 :5176 是在改 `VITE_API_BASE_URL` 之前起的。取"接口返回什么"的结论前先核对进程启动时间晚于 `.env` 的修改时间，与已知坑 7 是同一类。
- **dev 下新账号首挂载会建两条会话（已修）**：`StrictMode` 把 `Sidebar` 的挂载副作用跑两遍，而 `initFirstSession` 的"无会话才建"是 check-then-act、并发下不幂等，于是两遍各建一条。实测口径是数请求不是数 DOM（`node_modules/.scratch/cdp-double-session-probe.mjs` 用 CDP `Network.requestWillBeSent` 统计 `POST /api/sessions`）：改前 dev **2 次、间隔 21 ms**，同一份代码的**生产构建 1 次**（React 只在 dev 双跑 effect，所以线上从来没出现过这条 bug，也无法用线上复现）；给挂载 effect 加 `cancelled` 取消标记后 dev 也是 1 次。探针里 A、B 两条数量断言已从 `>= 1` 收回 `=== 1`，作为这个标记的守卫。

仍未覆盖（别当已验证）：语音 WS 的真机链路（无头环境没有麦克风，只做了单测层与关闭码翻译）、打开 `SPEND_DAILY_LIMIT` 之后的前端表现（闸门默认关着）、以及任何真实模型调用。

## 不在这一轮

找回密码的前端入口（只有"联系站长"文案 + 本地脚本）、邮箱验证、角色权限、按 token 计量与计费、偏好落库（4 个 localStorage key 原地不动）、部署与 CORS、RAG。

## 已知代价（写在这里不要将来当 bug 查）

- 一把共享 key 仍然共享，这一轮只让它**可记账**，没让它**被限制**。公开注册之后仍需在 P0-B 打开闸门。
- 无限量 + 无邮箱验证 ⇒ 一个人可以脚本化注册任意多个账号。这一轮接受，但记在 §11 之外这里。
- token 原文入库 ⇒ 谁读到 `app.db` 就等于拿到所有登录态。本机文件 + gitignore，MVP 接受；换远端库前先改 hash。
- CORS 与 WS 都只放开 localhost：这一轮之后仍只能本机跑。
