# 阿里云 Agent Skill 接入（capability 统一抽象 + skill provider） - SDD

需求来源：`docs/origin/26-9-19.md`（外部事实实测、第 7 节统一抽象、第 8 节 K1-K10 硬数字推导、第 9 节可借鉴实践）。
路线：A（只注入知识、不执行）。**这是推断不是点名** —— 用户的授权是"按工作流执行"（2026-09-19），B（让 agent 真去执行云侧命令）当场被否，C（云端开通执行面）不在本项目可控范围内，A 是剩下的唯一一条。若这不是你要的路线，现在改还来得及。

## 需求

用户描述需求时，模型目前只会凭通用知识产出前端代码，遇到云侧规范（参数命名、RAM 权限、避坑清单）就编。阿里云把这类经验打包成了 297 个 Agent Skill，经 AgentExplorer HTTP API 匿名可查（`docs/origin/26-9-19.md` 第 1 节）。本特性把它们接成**平台内可调、可见、可关的能力**。

关键判断是 skill 与 MCP 工具**不是同一种东西**：MCP 是一个 RPC 端点，调用即返回数据；skill 是写给"会跑 shell、持有云凭证"的 agent 看的操作手册，而本应用的 agent 只有 5 个虚拟文件系统工具 + iframe 预览，**没有任何命令执行面**（需求文档第 3 节）。所以首期只做知识注入：skill 正文进上下文，模型据此产出**产物**（代码、命令清单、步骤），界面明写"只生成不执行"。

第二个判断是接入方式：先把现有"外部工具"通道里那层带 `mcp` 前缀的抽象提升为通用 **capability**（管道统一：发现 → 注册 → 开关 → 面板 → 进度 → 错误契约），再往上挂 skill provider。两处语义**不统一**并显式建模成两个维度 —— `durability`（正文要跨过压缩存活）与 `effect`（返回值会改写模型行为）。

预算侧全部按真分词（tiktoken `cl100k_base`）定的量，落地时换算成字符（索引 1.5 字符/token、正文 3.8 字符/token，见 K1）。

## 实现步骤

### 步骤 1：capability 抽象（纯重构，行为不变）

| 文件 | 动作 |
|---|---|
| `packages/web/src/agent/types.ts` | `McpServerInfo`/`ExternalToolsSnapshot` → `CapabilitySourceInfo { id; label; kind: 'mcp' \| 'skill'; defaultEnabled }` 与 `CapabilitySnapshot { sources; enabled }` |
| `packages/web/src/agent/toolRegistry.ts` | `RegisteredTool.meta` 从 `{ mcpService? }` 改为 `{ provider, sourceId, durability?, effect? }`；`getDefinitionsFor(enabledSourceIds: Set<string>)` 的筛选条件换成按 `meta.sourceId`，**内置无 meta 工具恒在、绝不 unregister** 的纪律不变 |
| `packages/web/src/agent/externalTools.ts` | 拆成 `capabilityStore.ts`（清单 + 开关 + 快照 + 订阅，provider 无关）与 `providers/mcp.ts`（`doLoad` 拉 `/api/mcp/tools`、`makeExecutor` POST `/api/mcp/call`）。现有逻辑基本是搬，不改语义 |
| `packages/web/src/agent/runAgentLoop.ts` | `:7` 导入改名；`:54` `externalToolsReady()` → `mcpCapabilitiesReady()`（**只有 MCP 需要等**，见 K9）；`:59` `getEnabledServiceIds()` → `getEnabledSourceIds()` |
| `packages/web/src/components/McpServersPanel.tsx`(+`.css`) | → `CapabilityPanel.tsx`，两组标题；空态文案 "未接入外部工具" → "未接入能力" |
| `packages/web/src/components/ChatInterface.tsx` | `:9`、`:130` 换组件名 |
| localStorage | `mcp-servers-enabled` → `capabilities-enabled`。一次性迁移：读旧 key、并入新 key、删旧 key，全程 try/catch |
| `packages/web/src/agent/__tests__/externalTools.test.ts` | 改名 `capabilityStore.test.ts`，断言语义不变（快照引用稳定、失败退回空清单、筛选不注销） |

改完必须先让 `pnpm --filter web test:run` 回到全绿，再进下一步 —— 这一步没有任何新功能，绿是唯一判据。

### 步骤 2：后端 skill 只读通道

新增 `packages/server/app/skills/`（对齐现有 `app/mcp/` 的分层）与 `app/routes/skills.py`，在 `main.py` 注册。

- `sources.py`：`AGENT_EXPLORER_BASE`、UA `AlibabaCloud-Agent-Skills/<caller>`、`x-acs-version: 2026-03-17`、raw.githubusercontent 前缀。**目录是匿名接口，无 key 可泄**；但 `trust_env=False` + `httpx.Timeout(30.0, connect=10.0)` 与 `mcp/client.py:43` 同策略（本机系统代理那条变量）。
- `catalog.py`：逐个 `categoryCode` 翻页取全。守卫写成**两条独立断言**，不要写成"总数 == 297"（实测同日重跑只得 269 条，因为 `playbooks` 类目返回 HTTP 400 贡献 0 条 —— 见需求文档第 1 节那条重跑观察）：
  1. **逐类目**：每个 `categoryCode` 要么成功、要么把失败原样记进 `errors`，绝不把 400 吞成"该类目 0 条"（吞掉就是半份目录，索引成本会被低估一半以上）；
  2. **总量跌幅**：与"上一次成功结果"的条数比对，跌幅 > 10% 才判为拉取不完整、回退旧缓存。阈值是比例不是绝对值（K2 口径），上游下架几个 skill 不能变成永久故障。
  TTL **6 小时**（K7）。
- 四个端点，全部 **HTTP 恒 200、成败在 body**（与 `/api/mcp/*` 同契约，K8）：
  - `GET /api/skills/catalog` → `{ skills: [...], errors: [] }`
  - `GET /api/skills/search?keyword=&maxResults=` → 上游语义检索透传
  - `GET /api/skills/content?name=` → `{ text, truncated, original_chars }`，**不缓存**（仓库更新后照旧版手册产出是真会失效的）
  - `GET /api/skills/file?name=&path=` → 取该包 `references/*.md`
- **`/file` 的 path 校验是本特性唯一的注入面**，必须做到：`path` 只允许 `references/` 前缀；拒绝绝对 URL 与 `..`；解析后仍要在该 skill `githubPath` 的目录内；只允许 `.md`；请求目标 host 固定为 `raw.githubusercontent.com`（不接受调用方传 URL）。做不到这四条就是 SSRF + 路径穿越，不能上线。

### 步骤 3：skill provider 与三个工具

- `providers/skills.ts`：拉 catalog、注册 source `agent-skills`、持有**勾选集**（新 key `skills-selected: string[]`，全局偏好，理由同 MCP 的开关——它不属于任何一条会话）。
- 三个工具**静态注册**（定义不依赖异步清单，所以不占 K9 那条 race）：`skill_search`、`skill_load`、`skill_file`，`meta = { provider:'skill', sourceId:'agent-skills', ... }`。`skill_load` 标 `durability:'durable'` + `effect:'instructions'`，另两个是 `transient`/`data`。
- 三者的 `description` 里就写明"本应用不执行任何命令；技能正文里的 CLI/脚本调用要转译成写给用户的产物" —— 约束放在模型做选择的那一刻，而不是等它 load 完再补。
- **常驻索引**：`buildSystemPrompt(files)` → `buildSystemPrompt(files, skillIndex)`（`runAgentLoop.ts:25`，每轮重算）。索引段 = 勾选集内 skill 的 `name: description`，**整段 ≤ 9,000 字符**（= 6,000 真 token @1.5，softLimit 的 10%，K3）；被预算挤掉的部分要留一行"另有 N 个已选技能未列入目录，用 skill_search 查找"，不允许静默消失。
- **正文前言**：`skill_load` 返回文本头部固定拼一段"只生成不执行"的转译指令（随正文一起落库、一起被回放，见第 5 节）。
- **截断尾巴**：正文 32,000 字符、references 单文件 16,000 字符（K4/K6），写法沿用 `mcp/client.py:334`，且**不得**写"可用 skill_file 补齐"——`skill_file` 只能取 `references/`，补不回同一份 `SKILL.md` 的后半段。
- **断链要显式**：`/file` 找不到时回 `is_error` + "该引用文件未找到"。实测正文里 2,074 条 references 引用有 15% 在包里对不上文件，这是必然发生的边角。

### 步骤 4：压缩层的 durable 豁免（本特性最容易写坏的一处）

`contextBudget.ts` 现状：`toGroups:58-64` 把 `assistant(tool_calls)+tool` 打成 `toolRound`，`isCompressible:100` 认为整组可压 —— **第一个被压掉的正好是 skill 正文**，且 `summarizeToolRound:96` 那句占位符（"文件内容已存于工作区，需要时用 read_file 获取"）对 skill 完全不成立。

改法（约束在预算层内部，不新增调用方参数）：
1. 导出 `isDurableToolName(name)`（`skill_load`），`toGroups` 给 `toolRound` 标 `durable`。
2. **豁免要有额度**：只有**最近 2 个** durable 轮次豁免压缩，更早的回落成普通可压组（K5 —— 最坏 3 份正文就是 57,046 token = softLimit 的 95%，没额度时"豁免"会反过来把历史顶出去）。
3. 被降级/超预算的 durable 轮次用**专用占位文案**："该技能正文已移出上下文，需要时重新 skill_load(<name>)"，不要复用文件工具那句。
4. 阶段二 `hardTruncate` 仍整组丢，且**不得拆散 assistant↔tool 配对**（现有不变量）。

### 步骤 5：面板 UI

`CapabilityPanel` 技能组：总闸 `Switch` + "已选 N 个技能" + `Input.Search` + 可滚动 `Checkbox` 列表（勾到 K3 上限时禁用剩余项并说明原因）。头部固定一句"只生成不执行：技能只提供规范与产物，本应用不会替你执行云侧命令"。样式进 `CapabilityPanel.css` 的 class，JSX 只留动态量（AGENTS.md 样式归属条）。

### 步骤 6：文档与验证脚本

- `AGENTS.md`：架构地图补 `agent/capabilityStore.ts`、`agent/providers/*`、`app/skills/`、`routes/skills.py`；**状态不变量那条"外部工具是全局的"改写为"能力是全局的"**，并补一句 skill 正文是会话状态（落库）而勾选集是全局偏好。
- 零模型 token 的离线验证：`node_modules/.scratch/fake-skill-upstream.py`（假 AgentExplorer + 假 raw 域）+ `skill_routes_check.py`（打四个端点，含 SSRF 用例）+ `skill_budget_probe.py`（断言索引段/正文/份数三道闸的实际字节数）。`pnpm install` 会清掉，按 AGENTS.md 坑 6 重建。
  > **`skill_budget_probe.py` 这个名字已被占用**：现存那份是 K1 之前的 **÷3 估算**脚本，跑出来的是"索引 11,228 token / 正文 p50 6,284 token"这类**已被否决**的口径（真分词口径是 26,349t 与 4,590t）。验收时不要复用它的旧输出，要么按真分词阈值重写要么换名 —— 否则就是拿被否决的数去证明新阈值成立。
- 浏览器实测走自启无头实例那条路（AGENTS.md 坑 6：内嵌面板 `visibilityState` 为 hidden 时 rAF 一帧不发）。

## 验收标准

**重构不伤现状**
- [ ] 步骤 1 单独提交，`pnpm --filter web test:run` 全绿且用例数不少于现有基线；`getDefinitionsFor` 仍是"筛副本不注销"（有断言）
- [ ] 旧 `mcp-servers-enabled` 里的用户开关值迁移后仍在（含 localStorage 抛异常时的降级路径）
- [ ] `pnpm --filter web lint`、`pnpm build` 干净（`verbatimModuleSyntax` / `noUnusedLocals` 会抓残留导入）

**预算三道闸有实测数值（不是"看起来对"）**
- [ ] 常驻索引段 ≤ 9,000 字符，勾选 0 个时无该段；超上限时保留"另有 N 个未列入目录"提示行
- [ ] `skill_load` 单次返回 ≤ 32,000 字符且带 `（已截断，原文 X 字符…）`；一份完整 p50 正文（17,728 字符）**不被截断**
- [ ] `skill_file` 单次返回 ≤ 16,000 字符
- [ ] 连续 load 3 个技能后，最早的正文被降级为专用占位行；**只有最近 2 个 durable 轮次豁免压缩**（构造用例断言，含"durable 豁免 + 长历史"下阶段二丢的是整组对话而非正文、tool 配对不破）

**安全与契约**
- [ ] `/api/skills/file` 对 `path=../../etc/passwd`、绝对 URL、非 `.md`、越出该 skill 目录的四类输入全部拒绝，且拒绝发生在**发出外部请求之前**（有断言，不是靠日志看）
- [ ] 四个 skill 端点在任何上游故障下都返回 HTTP 200，错误信息在 body；响应里不含任何 key/鉴权头
- [ ] 前端 `AbortSignal.timeout` 严格大于后端 read 超时（35s > 30s）
- [ ] 全目录拉取的条数守卫生效：模拟某类目 400 时不产出"半份目录"，而是退回旧缓存并在 `errors` 里报出

**状态不变量（跨会话）**
- [ ] 会话 1 生成中 load 技能，切到会话 2：正文只出现在会话 1 的 `messages` 分片，不污染当前视图
- [ ] 技能执行器**全程不读写 `workspaceStore`**（断言：load 前后工作区快照不变）
- [ ] 勾选集/总闸是全局偏好：改它不进 `bySession`、不落库，且**不影响在飞那一轮**，下一轮才生效（与 MCP 同语义）
- [ ] `skill_load` 正文随 `saveMessages` 落库、刷新后可回放；中断的那一轮不写库

**"只生成不执行"是可核对的承诺，不是一句口号**
- [ ] 面板、三个工具的 `description`、正文前言三处都有该声明
- [ ] 离线用例：喂一条会命中技能正文的请求，产物里出现"供用户自行执行的命令清单 + 前置条件（CLI 版本、RAM 策略）"，且没有出现"我已执行/已创建"这类声称

**明确未覆盖（诚实标注，不要勾）**
- [ ] **端到端"模型自己选中并 load 了某个 skill"未验证** —— 需要一次真实模型调用，未获授权
- [ ] qwen 真实 tokenizer 与 cl100k 的偏差未对账（本 SDD 所有 token 数为代理口径，中文侧为上界）
- [ ] 全量目录端到端耗时、`raw.githubusercontent` 经后端的稳定性、未上架的 52 份 `SKILL.md` 可否按名取正文 —— 均未测
- [ ] 不合并 `main`（合并需另行点头）
