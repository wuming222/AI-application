# agent-skills 代码评审报告（阶段 D）

评审对象：`feature/agent-skills` 上技能通道这一整段（capability 抽象 + 两家合成目录 + 逐技能开关），基线 `main`。
评审时间：2026-09-20。评审人：Qoder agent（自审）。
配套：设计与验收见同目录 `SDD.md`（含 09-19 / 09-20 两节修订）。

严重度口径：**P0** 会泄露密钥/越权读文件/写坏别人数据；**P1** 会让承诺的功能在正常路径上不成立；**P2** 边界或观测性问题；**P3** 表达与腐化。

## 结论先说

没有 P0 / P1。P2 三条、P3 若干，本轮全部已修并已复测。两处需要用户决定的事项放在最后一节，我没有替他们改。

## 一、复核后判为"不是缺陷"的两条（评审清单里原有的）

### 1. `get_reference` 返回裸 `True` —— 复核：不是缺陷，是旧通道报告里的遗留条目

旧报告（agentexplorer 通道那轮）记着"`/api/skills/file` 的某个分支返回了裸 `True` 而不是 dict"。逐分支核过现版 `app/skills/catalog.py:125`：

| 分支 | 返回 |
|---|---|
| path 不合规 | `{"text": …, "is_error": True}` |
| 目录里没有这个技能 | `{"text": …, "is_error": True}` |
| 两家都取包失败 | `{"text": …, "is_error": True}` |
| 包里没有这个成员 | `{"text": … 列出包内文件, "is_error": True}` |
| 成功 | `{"text", "truncated", "original_chars", "is_error": False}` |

`_clip()` 返回的是三元组 `(text, truncated, original)`，两个调用点都解包成命名变量，不存在把元组第 2 项当响应体返回的形状。契约脚本里"缺文件回明确的未找到"与"未找到时列出包内文件"两条断言读的就是 `body["is_error"]` / `body["text"]`，都是 dict。真机侧 references 那一腿回 2,098 字符、界面不报"未找到"。**结论：现码无此问题，旧条目关闭。**

### 2. 索引段与工具定义"两处各判一次"（#17）—— 复核：症状真实，但修法不能只是补一个 if

这条在实现阶段已修，这里记的是**为什么那样修**。症状确实存在（09-19 实测：关掉技能开关，下一轮 `skill_*` 定义消失了，但常驻索引段还留在 system 里）。最省事的改法是在 `buildSkillIndexSection()` 头上补一句 `if (!isSourceEnabled(SKILL_SOURCE_ID)) return ''` —— **这个改法会被下一次的开关语义改动重新破掉**，因为它仍然是两处判据，只是这次刚好对上。

现在的改法是把判据收成一个：`SOURCE.resolveEnabled` 与 `buildSkillIndexSection()` 的第一行都读 `enabledNames.length`，工具注册走前者、索引注入走后者，**结构上不可能再分叉**。代价是 `CapabilitySourceInfo` 多了一个可选字段 `resolveEnabled`（MCP 用不到），这是抽象的真实扩展而不是特例硬编进 store —— `recompute()` 里"派生优先、派生时不读存值"那条规则是通用的。

真机验收：`hasIndexSegment=false` 且 `toolNames` 里无 `skill_*`。

## 二、本轮新发现并已修（P2）

### R-1 `follow_redirects=True` 把 `file_url` 的 host 白名单绕过了 —— P2（安全），已修

`bailian.get_package()` 里核了 `is_allowed_package_host(file_url)`，但 httpx 客户端是 `follow_redirects=True`：**白名单只作用在第一跳**。一个合法的 `.aliyuncs.com` 预签名地址回 302，客户端就会跟着去任意 host —— 包括 `169.254.169.254` 这类内网元数据地址。这个请求不带 Bearer（那是对的），但它仍然是一次由上游响应决定的服务端出网。

修法：改用 `event_hooks={"request": [_guard_package_host]}`，在**每一跳发出前**复核目标 host，`follow_redirects` 语义保留（OSS 真有跳转时不会莫名失败）。守卫函数抛 `BailianError` → 走既有"恒 200、错误在 body"的契约。

断言（`skills_routes_check.py` 组 D，直接喂 `httpx.Request` 构造，不碰网络）：合法 OSS 域放行；`evil.com` 拒；`http://…aliyuncs.com`（明文）拒；`169.254.169.254` 拒；`aliyuncs.com.evil.com`（后缀把戏）拒。

### R-2 上游响应里的 `skillId` / `latest_version` 没校验就拼进 URL 路径段 —— P2（安全），已修

`_fetch_listing()` 把上游的 `id` / `latest_version` 原样放进行里，`get_package()` 把它们插进 `{base}/skills/{skill_id}/versions/{version}/content`。这条通道"两个注入面都由请求方给"的说明写的是 `path` 与 `file_url`，**漏了第三个：由上游给、但同样决定我们去请求哪个路径的值**。上游给 `id="../../x"` 时请求就打到了别处。

修法：`_ID_RE` / `_VERSION_RE` 白名单 + `fullmatch`，不合法时在**发出请求之前**回绝；`version` 额外显式拒 `.` 与 `..`（它的字符类允许点号，`..` 能过正则而它正是路径段）。组 D 六种形状各一条断言，全部断言"RECORDED 为空"（拒绝发生在请求之前，不是靠日志看）。

### R-3 三处 `^…$` 配 `.match()`，`$` 会放过结尾换行 —— P2（一致性），已修

`local.py` 的 `_NAME_RE` 注释明确写了"不写 `^…$` 而用 fullmatch：`$` 会放过结尾那一个换行，而这串字符要拼进路径"，但**同一个文件**的成员白名单 `_ALLOWED_MEMBER` 和 `sources.py` 的 `_WORKSPACE_RE`（拼进主机名！）都是 `^…$` + `.match()`。R-2 新加的两条正则我一开始也写成了同样的形状 —— 被自己新加的断言（"skillId 带结尾换行"）抓到才改的。

三条统一改成"模式不带锚点 + 调用处 `fullmatch`"。补了一条用例：Linux 上文件名可以含换行，而 Windows 上不能，所以这个差异只在部署到 Linux 时才现形 —— 属于"现在不炸、换环境才炸"那一类。

顺带在断言里记下一条**不是 bug 的行为**：`workspace_id()` 先 `.strip()` 再校验，所以 `.env` 值两端带空白是合法的（手写的常态），而换行夹在中间（strip 救不了）必须被拒。

## 三、本轮新发现并已修（P3）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| R-4 | `bailian.get_listing(refresh=…)` | 死旋钮：全仓库没人传 `True`，实际刷新走 `invalidate()`，而后者语义更大（连解包缓存一起清）。读代码的人会以为传 `True` 只刷列表 | 删参数，docstring 写明刷新走哪条 |
| R-5 | `SkillPanel.runSearch` | `catch { setResults([]) }` 把"这次请求没成"渲染成"没有匹配的技能" —— 用户会以为技能不存在，而不是去重试 | 记 `searchError` 并在空态优先显示，文案里明说"这不是没有匹配的技能" |
| R-6 | `App.tsx:53`、`CapabilityPanel.tsx:13`、`SkillPanel.tsx:23` | 注释腐化：还写着旧通道的"按 18 个类目逐个翻页"、旧语义的"勾过技能 / 勾选"，以及一句断行错字 | 按现状改写 |
| R-7 | `SDD.md` 验收项 | 把截断上界写成"正文 ≤ 32,000 字符"。实测量：`_clip` 返回 `text[:limit] + 固定尾巴`，尾巴 72 字符，所以真实上界是 **32,072 / 16,072** | 按实测口径改写，并注明预算换算要用哪个数 |

## 四、看过但判为"不改"的（附理由）

- **内置目录每次请求都重读磁盘**（`local.get_listing()` 扫一遍目录、逐个 `SKILL.md` 折 description；`/search` 也走 `_collect()`）。百炼那家已经有 10 分钟列表缓存，内置没有。量级是"仓库里几个技能 × 每个几 KB"，加缓存换来的是"改了包要重启才生效"。**不加。**
- **没有索引块级缓存**：`buildSkillIndexSection()` 每轮重算（`buildSystemPrompt` 每轮调），纯字符串拼接 + `resolveEnabledSkills` 建一次 Map，成本远低于一次网络往返。**不加。**
- **同名遮蔽用"报错"而不是"警告"**：见下面第五节，这条要用户定。
- **`_PACKAGE_CACHE_SIZE = 8`、`MAX_ZIP_BYTES = 8 MiB`、`MAX_MEMBER_BYTES = 2 MiB`、`PAGE_LIMIT = 100 × MAX_PAGES = 20`**：都是"单人自用的技能库"量级下的随手安全值，没有实测支撑，但它们的失败模式是"取不到并报错"而不是"静默给半份"，可接受。**留，但值本身不作为结论引用。**

## 五、需要用户决定 / 未覆盖（不当已修处理）

1. **同名遮蔽让面板常驻"目录有 1 处异常"**。他的百炼库里恰好只有 `requirement-clarify`，与内置那份同名 ⇒ 目录只剩 `[内置]` 一行，且按"内置优先 + 报出被遮蔽那条"的规则，这条提示会一直挂在面板底部。三个选项：他把百炼那份改名或删掉（零改动）／把同名遮蔽从 `errors` 挪进不计异常的提示通道（要新 UI）／接受现状。**我没有替他选。**
2. **逐技能开关没有数量上限**。旧设计（`Checkbox` 列表）有"勾到索引预算上限就禁用剩余项"，改成一行一个 `Switch` 之后这个硬闸没了 —— 全开也不会被拦，超预算的部分从索引里掉出去、由面板顶部一行提示 + `skill_search` 兜住。我判断这是对的（用户能开的技能数由他自己的百炼库决定，不是我们该替他设的配额），但**这是语义变更不是等价重构**，要他确认。
3. **"模型自己会选中并 load 技能"端到端仍未验**。真机 24 项全部走假 LLM，零模型 token。有硬证据的是：索引行（含 `[内置]` 标签）真的进了 system、`skill_load` 回来的正文是包内那份 1,793 字符、references 走的是包内文件名、关掉开关后定义与索引一起消失。**没有**证据的是模型在真实调用里会主动选它 —— 照旧等点头。
4. **"正文只属于发起那条会话"没有端到端用例**：只做到"复用既有的按会话分片纪律 + 单测层无泄漏"。构造"后台那路 load、前台看另一条会话"的真机用例仍欠着。
5. `pnpm install` 会清掉 `node_modules/.scratch/` 下这批脚本；本轮那批旧通道残留（`fake_skill_upstream.py`、`skill_routes_check.py`、`bailian_routes_check.py`、`cdp-skill-*-probe.mjs`）已删，现存 `skills_routes_check.py` + `fake-llm-skills.mjs` + `cdp-skills-runtime-probe.mjs`，重建口径写在 `SDD.md` 步骤 6 与 AGENTS.md 坑 6。

## 六、验证记录（本轮全部重跑）

| 项 | 结果 | 命令 |
|---|---|---|
| 前端单测 | 116/116（14 文件；本轮 +5 全在开关语义） | `pnpm --filter web test:run` |
| lint | 0 error / 1 warning（既有：`Sidebar.tsx:155` exhaustive-deps） | `pnpm --filter web lint` |
| 类型 + 构建 | 通过，主 chunk 964.98 kB / gzip 313.58 kB | `pnpm build` |
| 服务端契约 | **66/66**（四组 A/B/C/D，含新加的 R-1/R-2/R-3 守卫） | `python node_modules/.scratch/skills_routes_check.py`（ASGITransport 直进 app，不占端口） |
| 真机端到端 | **24/24**，页面零告警，零模型 token | `node node_modules/.scratch/cdp-skills-runtime-probe.mjs` |

服务端改动（R-1/R-2/R-3/R-4）之后按 AGENTS.md 坑 7 的做法把 :8020 那个 scratch 进程**杀掉重启**再跑的真机 —— `--reload` 会假重载，不重启拿到的就是旧码的结论。契约脚本走 ASGITransport，每次都是新进程，不受影响。
