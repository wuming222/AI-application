# RAG MVP · 历史参考自动前置注入

- 状态：设计已逐段确认，待实现
- 日期：2026-10-03
- 分支：`feature/rag-mvp`（base `main` @ `5130192`）
- 上位依据：`docs/origin/26-9-20.md:156` 定死语料 = 用户自己的历史会话产物、按 user scope；框架文档类语料明确不走 RAG（skill 通道已在做同一件事且是人工精炼版）。本文不重开这条判断，只做实现设计。

## 一句话目标

让新生成能看见"这个账号以前让 AI 做过什么"：每轮生成开始前，用用户这句话去检索他历史会话里的需求原话与文件名，取 top-5 作为"历史参考"段注入 system prompt。

本版判据是**把 `索引 → 检索 → 注入 → 可开关` 四个接缝各自走通**，召回质量不评优。

## 本次需求澄清的四问四答

| 问 | 答 |
|---|---|
| 第一版要解决哪种失败 | 先验证检索链路能跑通（不是复用代码骨架、不是记住偏好、不是找回被截断内容） |
| 检索由谁发起 | 每轮自动前置检索，模型没有"要不要查"的决定权 |
| 注入什么形态 | 只注卡片（需求原话 + 文件名），不注文件正文 |
| 索引层做成什么 | 只索引需求原话与文件路径，不索引代码正文 |

## 架构

```
用户这句话
   │ 按标点/空白切片段，丢 <2 字，最多取 8 个
   ▼
GET /api/rag/search ──► rag_doc WHERE user_id=? AND session_id<>exclude
   │                     逐片段子串匹配(Python)，命中计数打分
   │                     按会话去重取最高分，score DESC + created_at DESC，LIMIT 5
   ▼
top-5 卡片 ──► buildSystemPrompt 追加"历史参考"段 ──► 模型
```

## 数据形状与写入路径

```sql
CREATE TABLE IF NOT EXISTS rag_doc (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,          -- 'requirement' | 'path' | 将来 'document'
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rag_doc_user ON rag_doc(user_id, kind);
```

**为什么 `user_id` 显式存一份**：`messages` 表本身没有 `user_id`，靠 JOIN sessions 继承归属（现有做法）。但检索这一路的隔离判据希望只有一句话 —— `WHERE user_id = ?`。多一张表就多一处"以谁为准"的机会，宁可把它关在这一张表里。

**回填跳过 `sessions.user_id IS NULL` 的存量行**。沿用既有不变量（NULL 归属的行谁都不属于），不能因为它们躺在库里就被检索出来。回填在 `init_db()` 里判 `rag_doc` 为空且 sessions 非空时做一次；重建本身幂等。

写入是一个函数、两个调用点：

```
sync_session_docs(user_id, session_id)
  DELETE FROM rag_doc WHERE session_id = ?            -- 该会话名下全删
  INSERT requirement 行  ← messages WHERE role='user'
  INSERT path 行         ← json.loads(workspaces.files) 的 keys，只取键不取正文
```

调用点：`POST /sessions/{id}/messages` 与 `PUT /sessions/{id}/workspace` 之后 —— 都是"整轮跑完才写"那一路。

**为什么两个点都写而不是挑一个**：落库顺序前端没有保证，挑一个就会出现"改了文件结构但卡片里的文件名还是上一轮的"。全删全插天然幂等，两个点各调一次不会叠加。

`json.loads` 只发生在单个会话的 blob 上，不是全库 —— 这是本方案比"现扫全库"在内存上安全的确切原因（实测单 blob 最大 18,281 字符）。

## 检索契约与打分

`GET /api/rag/search?q=<用户这句话>&exclude=<当前会话id>&limit=5`

- 鉴权不新写：这一路自动落在 `Depends(current_user)` 下面（`main.py` 除 auth/voice 外整组都挂了）。`user_id` 从 token 解出，**永不接受客户端传参**。
- 切片段：按标点与空白（，。？！、,.?! 空格 换行）切；丢长度 <2 的；最多取前 8 个。
- **选 LIKE 不选 FTS5 trigram 的理由**：实测 trigram 要求查询词 ≥3 字符，"天气"这类最有信息量的两字词直接搜不到；LIKE 无此下限。
- 打分：`score = 命中片段数`，`kind='requirement'` 命中算 2 倍权重。文件名不加权 —— 本地实测 5 个文件里有 5 个都叫 `index.html`，信息量为零，给权重只会搅乱结果。
- 排序 `score DESC, created_at DESC`（并列时近的优先）。

两条硬规则：

1. **同一会话只留最高分那一条，去重发生在 LIMIT 之前。** 先按会话取最高分、再截 5 条；否则一次检索很容易 5 张卡全是同一会话，用户看到的是"提了 5 遍天气"而不是"你以前做过 5 件事"。卡片按会话给、不按命中给。
2. **`exclude` 必传**，值为当前正在生成的会话 id。它的原话已在上下文里，检索回来是自己抄自己。

展示用的会话标题要 `JOIN sessions` 取 —— 这与上面"`user_id` 显式存一份，隔离判据只有一句话"不矛盾：隔离只看 `rag_doc.user_id` 那一列，JOIN 只为带出一个显示字段，不参与"这条属不属于你"的判断。

子串匹配放在 Python 侧而不是拼进 SQL 的 `LIKE`：`%` 与 `_` 在 `LIKE` 里是通配符，输入一个 `%` 等于"匹配全库"，5 张卡会变成随机 5 条历史。改成取出行之后 `fragment in body` 比对，用户输入不是模式，这个后门不存在；SQL 里只剩 `WHERE user_id = ?` 与 `session_id <> ?` 两个绑定参数。代价是按用户取全表行 —— 本版语料只有需求原话与文件名（实测本地 12 条会话合计 310 字符），且已实测 LIKE 扫 1000 行 / 6 MB 只要 7.6 ms，量级上无风险。验收断言"输入 `%` 不得返回全库"保留，测的正是"确实没有模式语义"。

卡片形态（服务端只回结构化数据，拼文本在前端做）：

```
## 历史参考（该账号过往会话，仅作偏好线索，不是本次需求的一部分）
- 「做一个杭州天气+周边咖啡店的落地页,数据要真实」  ·  天气·咖啡  ·  文件: index.html
- 「看一下佛山的天气」  ·  新对话  ·  文件: index.html
```

最后一句不是客套：注入段被模型当成用户的新要求执行是本设计最容易出的错，而这句话是唯一能便宜划清边界的地方。

卡片取文规则：一张卡的正文取该会话**最高分那一行**；若最高分落在 `path` 行（比如用户输入了 "index"），仍优先显示该会话的一条 `requirement` 原话、把命中的文件名跟在后面；若该会话一条 user 消息都没有，退回会话标题。

## 注入与开关

- 开关：`CapabilityKind` 加 `'rag'` + `applyProviderSources('rag', [SOURCE])`。`capabilityStore.ts` 与 `CapabilityPanel.tsx` 都不用碰 —— 面板按 `kind !== 'skill'` 过滤（`CapabilityPanel.tsx:28`），新 kind 自动出一行 Switch。
- `defaultEnabled: false`。判据不是偏好是既有先例：新接入的能力默认关（AntV 那条就是），因为开关一开就无条件给每个人第一轮加一次外部调用。
- **判据处只允许一个**（AGENTS.md"一个开关只允许有一个判据处"，09-19 踩过技能开关与索引段分家）：`isSourceEnabled('rag')` 的唯一读者是 `providers/rag.ts` 的 `fetchRagSection()`，关着就返回空串且**不发请求**。`buildSystemPrompt` 只接收已经算好的字符串 —— 让它读 store 会把判据劈成"拼接处读一次、发起处再判一次"，两边不一致时界面显示"历史参考"开着、实际根本没请求。
- **检索定在循环外一次**：`runAgentLoop.ts:82-88` 每轮重算 `allMessages[0].content`。若把检索写在 `buildSystemPrompt` 内，一轮 5 步工具调用就是 5 次 HTTP 往返，且第 2 次起会把"刚生成到一半的这轮"当历史。正确做法是进循环前 fetch 一次，存局部 const 作为第三个参数传入 —— 与 `skillIndex` 同构，只是那个每轮重算（目录异步来），这个锁死不变。
- 截断后果：卡片挂在 system 上，`hardTruncate` 的 `head` 是 `groups.slice(0, anchorIdx + 1)`，锚点（首条 user）之前全部无条件保留，所以**丢不掉**；代价是计入 `totalTokens(head)`、从 `hardLimit` 先扣。实测 84 token / 150000 = 0.06%，不值得为它写任何压缩逻辑。

## 降级

- 失败即空段：5xx / 超时 / 返回体坏掉 → `ragSection = ''`，生成照常跑。不往 progress 塞错误条，也**不写"没有找到历史参考"** —— 后者会被模型读成用户在抱怨它没记性。
- 超时沿用既有纪律：`runAgentLoop.ts` 已确立"MCP 握手最多等 2s，等不到就当本轮没有"（`MCP_HANDSHAKE_WAIT_MS`）。rag 取同档 2000ms，`Promise.race` + 复用同一个 `signal`，用户在检索期间点停止要能真中止。
- 不进每日额度计数。判据不是"它轻不轻"而是 `spend_log` 现成口径：只有会消耗上游 token 的端点算轮数（`title`/`mcp_call`/`voice_ws` 只记录）。rag_search 零模型调用，既不占轮数也不进记录 —— 它不是 LLM 开销，记进去会让"今天生成了多少轮"失真。

## 状态归属（AGENTS.md 要求改这类代码前必答）

检索结果**不是状态**：只活在那一次 `runAgentLoop` 的局部数组里，不进 `chatStore.bySession`、不落库、不进 localStorage。所以"生成中途切会话"天然安全，也正因为如此**不要把它做成 `bySession` 的一片** —— 那会凭空造出"跨会话内容存在单会话分片里"的语义。开关是全局偏好，跟着 `capabilities-enabled` 的既有例外走，换账号不跟着清，`resetAccountState.ts` 不用改。

## 实测依据

数字来源：本地运行时库 `packages/server/data/app.db`（只读打开，不写）+ 合成规模外推。探针脚本在 `node_modules/.scratch/`（`rag_corpus_probe.py`、`rag_corpus_probe2.py`、`rag_scale_probe.py`、`fts5_probe.py`；`pnpm install` 会清掉，按下述描述可重建）。

本地存量语料：12 条会话、123 条消息（其中 role='user' 29 条共 310 字符，均值 10.7、最长 23）、只有 5 条会话有工作区、每会话 1 个 `index.html`（8,219～18,281 字符）。

| 结论 | 实测值 | 用途 |
|---|---|---|
| LIKE 全扫 | 1000 行 / 6.01 MB → 7.6 ms，索引体积 0 | 支撑"不建 FTS 表"；本方案语料比它小两个数量级 |
| trigram 索引重建 | 500 会话 221 ms / 2000 会话 967 ms | 否掉"每轮懒重建"（乙方案） |
| trigram 索引体积 | 语料的 4.8 倍（6 MB→28.9 MB，24 MB→115 MB） | 否掉物化索引会把 app.db 撑得比代码还大 |
| trigram 查询下限 | ≥3 字符；2 字词"待办"命中 0 | 选 LIKE 不选 FTS 的直接依据 |
| SQLite FTS5 可用性 | 本机 3.45.3，FTS5 与 trigram 均可建表 | 确认"不用 FTS"是取舍不是限制 |

预算更正：本设计讨论早期按"卡片带 ±200 字 snippet"估过 500 token。本方案不索引正文，按实测 5 张卡约 250 字符 ≈ 84 token（项目自身估算器 `contextBudget.ts:17` 的 3 字符≈1 token），占软限 60000 的 0.14%。单条 body 截到 160 字符是"极宽松天花板"，只防有人把整份 PRD 粘成一句话；用满 5×160=800 字符 ≈ 267 token = 软限 0.4%，仍不值得写压缩逻辑，所以这个取值不需要调准。

## 验收标准

功能

- [ ] A 账号搜自己说过的独有词命中；B 账号搜同一个词返回空
- [ ] 当前正在生成的会话不出现在结果里（`exclude` 生效）
- [ ] 同一会话只返回一张卡
- [ ] 查询含 `%` 或 `_` 时不匹配全库任意内容（转义生效）
- [ ] 开关关掉 → system prompt 里没有"历史参考"段

跨会话

- [ ] 生成中途切到另一条会话 → 检索结果不污染新会话上下文
- [ ] 生成中途翻开关 → 在飞那轮不受影响，下一轮才生效
- [ ] 删掉一条会话 → 它的 `rag_doc` 行随 `ON DELETE CASCADE` 消失，无孤儿行（这是本设计唯一一处真正的越权风险）

降级

- [ ] 服务端 5xx / 超时 → 生成照常跑，界面不报错
- [ ] 检索期间点停止 → 请求被中止，不继续等

验证方式

- 服务端契约：沿用 `auth_check.py` 模式（`APP_DB_PATH` 指临时库 + `httpx.ASGITransport` 直接进 app，不占端口、不碰 dev server），覆盖上面 5 条功能 + 2 条降级
- UI 侧：无头 Chrome CDP 验"开关翻动后下一轮 system prompt 变化"与"检索失败时界面静默"
- `pnpm build` 已可用但仍以 `pnpm --filter web test:run` 为主口径；`runAgentLoop.ts` 本身零单测，只能靠离线假 LLM 链路兜（AGENTS.md 坑 5、坑 6）

## 非目标（本版明确不做）

- 不搜代码正文，只搜需求原话与文件名。因此**复用不了历史骨架** —— 卡片只能告诉模型"你以前提过天气落地页、那次有个 index.html"。
- 不是 Self-RAG：模型没有"要不要查"的决定权，也没有对检索结果做反思打分。本版是固定前置召回（fixed top-k retrieval）。
- 不做相关性排序优化（bm25 / rerank），LIKE 命中计数够用就停。
- **不用 embedding，检索全程零模型调用**（这条与"不用 FTS5"是两个独立决定，别混成一条）。不用向量检索的具体代价是：`routes/llm.py` 转发的 path 写死只有 `/chat/completions` 与 `/responses` 两条，上向量要新开端点并新配一个模型名；索引时与查询时各多一次上游调用，这就落进 `spend_log`"只有消耗 token 的端点算轮数"的口径里，每日计数得跟着重算；而本版语料是需求原话（实测均值 10.7 字符 / 最长 23），这么短的文本上向量能挣到的区分度有限。真要上，位置是 `rag_doc` 旁边加一列向量、检索层把命中计数换成相似度排序，`kind` 枚举不动。
- 不做 memory.md 式蒸馏归纳。
- 不接外部文档库。`kind='document'` 是给它的预留位，本版不写任何相关代码。

## 留给下一版

- 若真要"复用历史骨架"：加 `rag_fetch` 工具让模型按卡片里的 session id + path 拉全文（实测 top-3 全文 ≈ 12.6k token = 软限 21%，要先解决 token 精确测算，那是 `docs/origin/26-9-20.md:142` 排在本条之前的那一格）。
- 若要 memory.md 路线：跨会话蒸馏成一份账号画像并全量注入。代价是要在生成主循环里加一次模型调用，会同时碰"整轮跑完才落库"的时机与 `spend_log` 的记账口径 —— 这两处比 LIKE 打分麻烦得多，所以没并进本版。

## 一处与既有排期的冲突，记录在案

`docs/origin/26-9-20.md:142` 的排序是「token 精确测算 → 摘要策略 → RAG」，前两件至今未做（`contextBudget.ts:17` 仍是 3 字符≈1 token 的估算）。本版把 RAG 提到前面执行，成立的前提是注入量小到可忽略（实测 0.14%）；一旦将来注到"必须算预算"的量级，那个未测的估算器就是硬前提。
