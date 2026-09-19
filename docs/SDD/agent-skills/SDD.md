# 阿里云 Agent Skill 接入（capability 统一抽象 + skill provider） - SDD

需求来源：`docs/origin/26-9-19.md`（外部事实实测、第 7 节统一抽象、第 8 节 K1-K10 硬数字推导、第 9 节可借鉴实践）。
路线：A（只注入知识、不执行）。**这是推断不是点名** —— 用户的授权是"按工作流执行"（2026-09-19），B（让 agent 真去执行云侧命令）当场被否，C（云端开通执行面）不在本项目可控范围内，A 是剩下的唯一一条。若这不是你要的路线，现在改还来得及。

## 需求

用户描述需求时，模型目前只会凭通用知识产出前端代码，遇到云侧规范（参数命名、RAM 权限、避坑清单）就编。阿里云把这类经验打包成了 297 个 Agent Skill，经 AgentExplorer HTTP API 匿名可查（`docs/origin/26-9-19.md` 第 1 节）。本特性把它们接成**平台内可调、可见、可关的能力**。

> 这段里的"297 条匿名目录"是**立项时的上游**。R1 之后这条通道整段下线，换成百炼的技能库（用户自己上传的那些，要鉴权）；需求本身没变，变的是谁供给技能。所以"接成可见可关的能力"这套管道照用，K1~K10 的预算数字里凡是按"297 条"算出来的影响面都只作历史参照 —— **常驻索引之所以要有 9,000 字符上界，依据是"一条索引行 89 token × 条数不可控"这个形状，不是 297 这个数**。

关键判断是 skill 与 MCP 工具**不是同一种东西**：MCP 是一个 RPC 端点，调用即返回数据；skill 是写给"会跑 shell、持有云凭证"的 agent 看的操作手册，而本应用的 agent 只有 5 个虚拟文件系统工具 + iframe 预览，**没有任何命令执行面**（需求文档第 3 节）。所以首期只做知识注入：skill 正文进上下文，模型据此产出**产物**（代码、命令清单、步骤），界面明写"只生成不执行"。

第二个判断是接入方式：先把现有"外部工具"通道里那层带 `mcp` 前缀的抽象提升为通用 **capability**（管道统一：发现 → 注册 → 开关 → 面板 → 进度 → 错误契约），再往上挂 skill provider。两处语义**不统一**并显式建模成两个维度 —— `durability`（正文要跨过压缩存活）与 `effect`（返回值会改写模型行为）。

预算侧全部按真分词（tiktoken `cl100k_base`）定的量，落地时换算成字符（索引 1.5 字符/token、正文 3.8 字符/token，见 K1）。

## 修订：本文以下"实现步骤"里被划掉的部分以本节为准

原步骤 2、步骤 5 写的是**第一版接的那条通道**（阿里云 agentexplorer 匿名目录 + `CapabilityPanel` 里的技能组）。09-19、09-20 两次改动之后，通道换掉了、UI 拆出去了、开关语义也换了。**K1~K10 的预算口径全部仍然生效**（9,000 / 32,000 / 16,000 三道闸、超时链、durable 豁免额度、按比例取值不按绝对值），被推翻了只有"上游是谁"和"开关长什么样"两件事。

### R1（09-19）上游换成百炼 Managed Agents 的 Skill API

| 项 | 旧（agentexplorer） | 现（百炼） |
|---|---|---|
| 端点 | 匿名 HTTP，按 18 个 `categoryCode` 翻页 | `https://{BAILIAN_WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`，一次列表取全（`sources.py:59`） |
| 鉴权 | 无 | `Authorization: Bearer {LLM_API_KEY}`（复用同一把 key，只是端点把 workspace 写进了主机名） |
| 目录守卫 | 逐类目 400 断言 + 跌幅 >10% 回退旧缓存（步骤 2 那两条） | **两条一起删**：没有"半份目录"这个失败模式了 —— 一次请求要么成要么错 |
| 正文怎么来 | `raw.githubusercontent.com` 按路径取 | 四步链：问版本 → 拿 `file_url`（OSS 预签名）→ 下 zip → 解包（`bailian.py`） |
| 正文缓存 | 刻意不缓存 | 按 `(skill_id, version)` 缓存**整包**，版本一变 key 就变（K7 那条"旧手册"的风险由版本身份兜住，不需要 TTL） |
| source id | `agent-skills` | `skills`（`providers/skills.ts:31`）；旧值有一次性迁移 |
| `检索` | 上游语义检索透传 | **本地子串匹配**（`catalog.py:84`）—— 百炼这个接口没有 keyword 参数，索引里没有的技能我们本来也拿不到，假装能搜到才是问题 |

新增的两个注入面（旧通道的 `githubPath` 拼接没了，换来这两个）：`file_url` 由上游给，取之前核 scheme 与 `.aliyuncs.com` host 后缀，且**不带 Bearer**（签名已在 URL 里，把 key 发给 OSS 是没必要的泄露，`sources.py:66`）；`name` 在拼成目录路径前先过 `validate_skill_name`。

### R2（09-20）内置技能源 + 逐技能开关（去掉总闸）+ #17 修法

**(a) 目录变成两家合成。** 服务端新增 `app/skills/local.py` + `app/skills/local_skills/<name>/`，技能随仓库分发、不鉴权、不发外部请求；`catalog._collect()` 把两家合成一份，行形状统一（前端 `toSummaries` 不需要按来源分支取值，只在标签上分 `[内置]` / `[百炼]`）。

两条与"合成"绑在一起的纪律：
1. **内置先取，且不受上游成败影响**（`catalog.py:52`）—— 百炼列表失败只能让百炼那几家消失，不能把随仓库分发的技能一起带走，否则"外网抖动"会表现成"你一个技能都没有"。
2. **名字是唯一身份，同名时内置赢**（`catalog.py:69`）—— 被遮蔽那条以 error 形式报出来不静默丢弃；目录 / 正文 / 引用三处解析全走同一个 `_open()`（`catalog.py:100`），两处各判一次就会出现"目录里没有但它能取到"。

内置目录的注入面按"零 I/O 先校验"处理：`_NAME_RE` 用 `fullmatch` 不用 `$`（`$` 会放过结尾那个换行，而这串字符要拼进路径），`skill_dir()` 语法校验之后还要确认解析后 `target.parent == ROOT`，成员白名单 `^(SKILL\.md|references/[^/].*\.md)$` —— `scripts/` 尤其不读（这个特性只生成不执行）。

**(b) 技能没有总闸，开关是逐技能的。** 按用户点定的形态：面板一行一个 `Switch`（内置与百炼同构、同一套交互），`capabilities-enabled` 里**不再存技能那一格**。

代价与配套机制：整家"开不开"必须从逐技能开关集**派生**，不能让 `capabilityStore` 再读一份存值 —— 否则就是第二个真相源。为此在 `CapabilitySourceInfo` 上新增可选 `resolveEnabled()`，`recompute()`（`capabilityStore.ts:89`）优先走它、派生时不读存值。这是抽象的一处真实扩展（MCP 那家用不到），所以它必须是可选字段而不是把 skill 的特例写进 store。

一次性迁移：`legacyMaster = peekSourceOverride('skills') ?? peekSourceOverride('agent-skills')`，随后把两格都 `forget`（`providers/skills.ts:86`）。`legacyMaster === false` → 清空逐技能开关集并落盘 —— 他亲手关过总闸，就不能让升级后那几个技能自己亮起来。原语 `peekSourceOverride` / `forgetSourceOverride` 是通用的（"哪个 id 已死、旧值意味着什么只有那家自己知道"），所以判断留在 provider，store 只管读写存值；上一版的 `renameLegacySourceId('agent-skills','skills')` 随之下线。

**(c) #17（索引段未随开关收敛）的修法是把两处判据合成一处。** 症状：关掉技能开关后，下一轮的 `skill_*` 工具定义确实消失了，但常驻索引段还留在 system 里 —— 因为"注册不注册工具"读 `isSourceEnabled`，"注入不注入索引"读的是另一个条件。

改法不是给 `buildSkillIndexSection()` 补一个 `if (isSourceEnabled(...))`（那还是两处各判一次，下次改开关语义还会漏），而是让两者读同一个 `enabledNames.length`：`SOURCE.resolveEnabled` 与 `buildSkillIndexSection()` 的头一行是同一个判据，**结构上不可能再分叉**。真机验收：`hasIndexSegment=false` 且 `toolNames` 里无 `skill_*`。

**(d) UI 拆成独立入口**（09-20 更早的改动，同一个面板挤）：`SkillPanel.tsx` / `.css` 独立，composer 上一个单独的 `skill-btn`；`CapabilityPanel` 回到只管 MCP。样式与 MCP 行同构（`.capability-panel-row` 的 flex space-between）。

**(e) 关掉的那一个要指名道姓地回。** 执行器现在有三条拒绝路径：整家关（`SOURCE_OFF_RESULT`）、只关这一个（`skillOffResult(name)`）、目录里没有。第二条必须带技能名并指向面板 —— 只说"未启用"，模型会以为是服务故障，然后接着试第二个技能名。`skill_search` 的检索范围同样收窄到"开关打开的那些"：它的用处不是发现新技能（那是面板的事），而是把超出常驻索引预算、没列进目录的那部分捞回来。

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

> **本步的上游具体项（`AGENT_EXPLORER_BASE`、按 `categoryCode` 翻页、跌幅守卫、TTL 6 小时、`raw.githubusercontent` 前缀）已被 R1 整段取代。**仍然生效的只有两条纪律，它们与通道无关：**四端点恒 200、成败在 body**；**畸形 `path` 必须在发出任何外部请求之前回绝**（校验是纯语法、零 I/O 的，所以做到这一点不需要先读盘）。

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

- `providers/skills.ts`：拉 catalog、注册 source `agent-skills`（**R1 后改名 `skills`**）、持有**勾选集**（新 key `skills-selected: string[]`，全局偏好，理由同 MCP 的开关——它不属于任何一条会话）。**R2 后这个"勾选集"就是唯一开关**：`skills-selected` 这个 key 没换，但语义从"选了哪些要注入"变成"哪些技能开着"，且它不再配一个总闸（见 R2.b）。
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

原设计（技能组挂在 `CapabilityPanel` 里、顶部一个总闸 + `Checkbox` 列表）已在 09-20 两次改动后被否：先是与 MCP 挤在同一面板太拥挤，拆成 composer 上独立入口 `SkillPanel.tsx`；再去掉总闸。

**为什么不留总闸**：逐技能开关已经是唯一状态源，再放一个"整体开/关"就会有两个可以互相矛盾的真相（"总闸开着但一个技能都没开"和"总闸关了但开关集里还有名字"都得定义语义）。所以这一家的"开不开"是**派生**的 —— 有一个开着才算开，一个都不开等于整家关，界面与 `resolveEnabled` 读同一份。代价写在 R2.b：`legacyMaster` 那次迁移必须把"曾经亲手关过总闸"翻译成"逐技能全关"。

行样式与 MCP 的能力面板同构（`.capability-panel-row` 那种 flex space-between：左边标签，右边 `Switch size="small"`），标签里带 `[内置]` / `[百炼]` 来源角标与 `Tooltip`（说明文案，`placement="left"`）。头部只有标题与"已开 N 个"计数；被索引预算挤掉时在头部下面留一行 `.skill-panel-over-cap` 提示，不静默消失。状态样式全进 `SkillPanel.css` 的 class，JSX 不放 inline style（AGENTS.md 样式归属条）。

### 步骤 6：文档与验证脚本

- `AGENTS.md`：架构地图补 `agent/capabilityStore.ts`、`agent/providers/*`、`app/skills/`、`routes/skills.py`；**状态不变量那条"外部工具是全局的"改写为"能力是全局的"**，并补一句 skill 正文是会话状态（落库）而勾选集是全局偏好。
- 零模型 token 的离线验证（R1 之后实际存在的那批，旧通道的 `fake-skill-upstream.py` / `skill_routes_check.py` / `bailian_routes_check.py` 已作废删除）：
  - `skills_routes_check.py` —— 用 `httpx.ASGITransport` 直接进 app（不占端口、不碰用户的 `--reload` 进程），52 项断言分四组：A 内置（取正文/references **零外部请求**、同名遮蔽提示、非法 name 不泄漏路径、成员白名单解包结果）、B 百炼（把 `local.ROOT` 指到空目录让"内置优先"反向生效，测两步外部请求 + 缓存命中 + 降级）、C 百炼故障不带走内置、D 上游给的 `skillId`/`version` 形状不合法时在请求之前回绝（灌列表缓存构造，不依赖真上游）。断言"拒绝发生在请求之前"靠的是包装 `make_client` 记录 URL，不是看日志。
  - `fake-llm-skills.mjs` + `cdp-skills-runtime-probe.mjs` —— 假 Responses SSE（按 `[TOOL:name:arg]` / `[SLOW:n]` 逐腿下发 function_call，`/__probe/llm-requests` 记录每一腿的 system 与函数结果）+ 自启无头 Chrome 走 CDP，24 项真机断言。判据全落在"发给模型的请求记录"上：索引行的 `[内置]` 标签有没有真的进 system、`skill_load` 回来的正文是不是包内那份、技能执行器有没有碰工作区、关掉之后 `toolNames` 与 `hasIndexSegment` 是否一起消失。
  > 旧文档里 `skill_budget_probe.py` 那条警告仍然成立，但那份脚本本身随旧通道一起删了：**÷3 估算口径（"索引 11,228 token / 正文 p50 6,284 token"）已被真分词口径否决**，谁重建都不要沿用它的输出。
- 浏览器实测走自启无头实例那条路（AGENTS.md 坑 6：内嵌面板 `visibilityState` 为 hidden 时 rAF 一帧不发）。

## 验收标准

勾上的项带实测出处；未勾即未验证，不要靠"看起来对"打勾。验证脚本都在 `node_modules/.scratch/`（`pnpm install` 会清掉，重建口径见 AGENTS.md 坑 6）。

**重构不伤现状**
- [x] 步骤 1 的 capability 抽象不改变行为：`getDefinitionsFor` 仍是"筛副本不注销"（`toolRegistry.test.ts` 有断言）；`pnpm --filter web test:run` **116/116 全绿**（基线 111，本轮 +5 全在技能开关语义上）
- [x] 旧 `mcp-servers-enabled` 里的值迁移后仍在，`capabilities-enabled` 读不到时 try/catch 降级（`capabilityStore.test.ts` 22 用例含隐私模式路径）
- [x] `pnpm --filter web lint` 0 error（1 条既有 warning）、`pnpm build` 通过（主 chunk 964.98 kB / gzip 313.58 kB）

**预算三道闸有实测数值**
- [x] 常驻索引整段 ≤ 9,000 字符；超预算留"另有 N 个已开技能未列入目录"提示行（`skillsProvider.test.ts` 断言 `renderSkillIndex` 纯函数返回值）
- [x] 已开技能数为 0 时无该段 —— 且这条与工具注册是**同一个判据**（`resolveEnabled` / `buildSkillIndexSection` 都读 `enabledNames.length`）
- [x] 截断发生在 32,000 / 16,000 处，**返回长度是"上界 + 固定 72 字符提示尾巴"，不是严格 ≤ 上界**（实量：40,000 字符输入返回 32,072）—— 预算换算用 32,072 / 16,072；尾巴不写"可用 skill_file 补齐"（`skills_routes_check.py` 组 A/B）
- [x] durable 豁免只有最近 2 组、降级用专用占位文案（`contextBudgetDurable.test.ts` 5 用例）
- [ ] **真机只测到 1 份正文**（`skill_load` 一次，实测 1,895 字符未截断）；连续 load 3 个技能后最早那份被降级这条**只有单测覆盖**，无端到端证据

**安全与契约**
- [x] `/api/skills/file` 的 `path` 畸形输入（`../`、绝对 URL、`\`、非 `.md`、控制字符、`references/` 裸前缀）9 类全部拒绝，且断言"拒绝之前零外部请求"（`skills_routes_check.py` 用包装过的 `make_client` 记录 URL，不是看日志）
- [x] 内置技能名注入面 8 类非法输入（含 `%2e%2e/`、`a/../../b`、结尾换行）全部回绝且不泄漏路径
- [x] **上游响应里的 `skillId` / `latest_version` 也算注入面**（评审 R-2 补）：它们要拼进下一个请求的 URL 路径段，所以过 `_ID_RE` / `_VERSION_RE` 白名单且拒绝 `..`，不合法时在发出请求之前回错误（组 D 四类）；内置包成员白名单同理由 `.match` + `$` 改成 `fullmatch`
- [x] 四端点在任何上游故障下恒 200、错误在 body；响应与正文里不含 key（组 A/B/C 各有断言）
- [x] 前端 `AbortSignal.timeout(35_000)` 严格大于后端 read 30s（`providers/skills.ts:29`）
- [x] 百炼列表失败不带走内置（组 C 专项断言：`errors` 有百炼那条、`skills` 里内置那条还在）
- [ ] ~~全目录跌幅守卫生效~~ —— **随 R1 作废**：百炼一次请求拿全量，"半份目录"这个失败模式没了来源

**状态不变量（跨会话）**
- [x] 技能执行器全程不读写 `workspaceStore`：真机跑完 skill_load + skill_file 后逐会话取工作区，所有会话 `files` 为空（`cdp-skills-runtime-probe.mjs` 组 5）
- [x] 开关是全局偏好：`skills-selected` 落盘，`capabilities-enabled` 里技能那格为 `null`（真机断言，同时验证总闸那次迁移把两格都清掉了）
- [x] 关开关只影响下一轮：`setSkillEnabled` 后 `notifyStore()` 重算快照，在飞那轮的 `definitions` 不变（单测 + 真机各一条）
- [x] **关掉之后常驻索引段从 system 里消失**（#17 的验收：真机第二腿 `hasIndexSegment=false` 且 `toolNames` 无 `skill_*`）
- [x] 会话 1 生成中切会话 2 不污染视图：正文是 `role:'tool'` 消息落 `bySession[sessionId]`，复用既有落库纪律（`session-state-isolation` 那批断言仍绿）
- [ ] **"正文只属于发起那条会话"端到端未验**：跨会话隔离本轮只做到"复用旧纪律 + 单测层无泄漏"，没有构造一条"后台那路 load、前台看另一条会话"的真机用例

**"只生成不执行"是可核对的承诺**
- [x] 面板头部、三个工具的 `description`、`skill_load` 正文前言三处同一句 `GENERATE_ONLY_NOTICE`（常量单一来源，不是三处手抄）
- [x] 内置成员白名单不含 `scripts/`，`_ALLOWED_MEMBER` 只有 `SKILL.md` 与 `references/*.md`
- [ ] 离线用例：喂一条命中技能正文的请求、产物里出现"供用户自行执行的命令清单 + 前置条件" —— 需要真实模型调用，未获授权

**明确未覆盖（诚实标注，不要勾）**
- [ ] **端到端"模型自己选中并 load 了某个技能"未验证** —— 真机那 24 项全部走假 LLM（`fake-llm-skills.mjs` 按 `[TOOL:...]` 标记逐腿下发 function_call），零模型 token。所以"索引段/前言真的进了 system""正文是百炼 zip 里那份"有硬证据，"模型会主动去 load"没有
- [ ] 同名遮蔽的界面后果待他决策：他的百炼库里只有 `requirement-clarify`，与内置那份同名 ⇒ 目录只剩 `[内置]` 一行，且遮蔽提示计入 `errors`，面板会**常驻"目录有 1 处异常"**。改口条件：他把百炼那份改名或删掉；或把同名遮蔽从 `errors` 挪进一条不计异常的提示通道（要新的 UI）
- [ ] qwen 真实 tokenizer 与 cl100k 的偏差未对账（本文所有 token 数为代理口径，中文侧为上界）
- [ ] 百炼侧非 `active` 状态（`checking`）的技能、`updatedAt` 为空对面板排序的影响未测（内置那条恒为 `null`）
- [ ] 不合并 `main`（合并需另行点头）
