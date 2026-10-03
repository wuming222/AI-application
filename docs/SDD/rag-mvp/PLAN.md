# RAG MVP（历史参考自动前置注入）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 `docs/SDD/rag-mvp/SDD.md` 实现"每轮生成前检索该账号历史会话的需求原话与文件名，取 top-5 卡片注入 system prompt"，四个接缝（索引→检索→注入→可开关）各自走通。

**Architecture:** 服务端新增 `rag_doc` 派生表，跟着消息/工作区落库同步；一个 `GET /api/rag/search` 做子串打分检索；前端新增一个 `rag` capability source（默认关，复用能力面板）与一个 provider 模块，在 `runAgentLoop` 进循环之前检索一次、把拼好的字符串作为第三个参数传给 `buildSystemPrompt`。

**Tech Stack:** FastAPI + SQLite（`packages/server/app/`）、React 19 + TS + zustand + vitest（`packages/web/src/`）、pnpm workspace。服务端契约断言用 `httpx.ASGITransport` 直进 app，不占端口。

**Commands（全部在仓库根目录）:**

| 用途 | 命令 |
|---|---|
| 前端单测 | `pnpm --filter web test:run` |
| 前端类型+打包 | `pnpm build` |
| 服务端断言 | `cd packages/server && APP_DB_PATH=<临时库> "/c/Users/huangwenshi/AppData/Local/Programs/Python/Python312/python.exe" ../../node_modules/.scratch/rag_check.py` |

Windows 下 `python` 命令指向 Store stub，会 exit 49；一律用上面那个完整路径。中文直出要带 `PYTHONIOENCODING=utf-8`。

---

## 先更正规格的两处（Task 0）

写计划时发现 SDD 有两处需要改，不是实现细节，是判据位置和风险面：

1. **判据处位置。** SDD 写"`isSourceEnabled('rag')` 只允许 `buildSystemPrompt` 读"，但 `buildSystemPrompt` 是纯字符串拼接，让它读 store 就把开关判据劈成了两半（拼接处读一次、发起请求处再判一次）。改成：**唯一一次读放在 `providers/rag.ts` 的 `fetchRagSection()` 里**，关着就返回 `''` 且不发请求；`buildSystemPrompt` 只接收算好的字符串。判据仍然只有一个，且发起与拼接不再可能不一致。

2. **风险面消失。** SDD 的"安全点"整段是为"逐片段拼进 SQL 的 `LIKE`"准备的（`%`/`_` 是通配符，不转义就是一个字符读走全库）。改为**在 Python 侧做子串匹配**：`WHERE user_id = ?` 仍然只绑两个参数，语料行取出来后用 `f in body` 比对。用户输入不再是模式，那个后门不存在。代价是按用户取全表行 —— 已实测该量级无妨（LIKE 扫 1000 行 / 6 MB = 7.6 ms，而本版语料比它小两个数量级，行内只有 ≤160 字符的需求原话与文件名）。断言"输入 `%` 不得返回全库"保留，只是它现在测的是"确实没有模式语义"。

---

## File Structure

| 动作 | 路径 | 责任 |
|---|---|---|
| Create | `packages/server/app/rag.py` | 切片、打分、同步索引、回填、检索。不碰 HTTP、不碰 FastAPI |
| Create | `packages/server/app/routes/rag.py` | 只有一个 GET 端点的薄壳 |
| Modify | `packages/server/app/database.py` | `rag_doc` DDL + 索引；`init_db()` 末尾调回填 |
| Modify | `packages/server/app/routes/sessions.py` | 两个调用点各加一行 `sync_session_docs` |
| Modify | `packages/server/app/main.py` | 注册 rag router |
| Create | `node_modules/.scratch/rag_check.py` | 服务端契约断言（不提交，`node_modules` 已忽略） |
| Modify | `packages/web/src/agent/types.ts` | `CapabilityKind` 加 `'rag'` |
| Create | `packages/web/src/agent/providers/rag.ts` | source 注册 + 检索发起 + 卡片文本化（纯函数分离） |
| Create | `packages/web/src/agent/__tests__/ragProvider.test.ts` | 上表纯逻辑 |
| Modify | `packages/web/src/agent/runAgentLoop.ts` | 循环外检索一次 + `buildSystemPrompt` 第三参 |
| Create | `packages/web/src/agent/__tests__/runAgentLoopRag.test.ts` | 首次给主循环建桩，断言"只检索一次"与降级 |
| Modify | `docs/SDD/rag-mvp/SDD.md` | Task 0 的两处更正 |
| Modify | `docs/origin/26-10-3.md` | 验收勾选（勾=已实测，不是已写完） |

---

## Task 0: 更正 SDD 的两处判据

**Files:**
- Modify: `docs/SDD/rag-mvp/SDD.md`

- [ ] **Step 1: 改判据处那一条**

把"注入与开关"小节里这一条：

```markdown
- **判据处只允许一个**（AGENTS.md"一个开关只允许有一个判据处"，09-19 踩过技能开关与索引段分家）：`isSourceEnabled('rag')` 只允许 `buildSystemPrompt` 读。前端发起请求那处不得再读一次 —— 判了就是两个真相源。
```

替换为：

```markdown
- **判据处只允许一个**（AGENTS.md"一个开关只允许有一个判据处"，09-19 踩过技能开关与索引段分家）：`isSourceEnabled('rag')` 的唯一读者是 `providers/rag.ts` 的 `fetchRagSection()`，关着就返回空串且**不发请求**。`buildSystemPrompt` 只接收已经算好的字符串 —— 让它读 store 会把判据劈成"拼接处读一次、发起处再判一次"，两边不一致时界面显示"历史参考"开着、实际根本没请求。
```

- [ ] **Step 2: 改安全点那一段**

把"检索契约与打分"小节里以 `安全点（不实现就是静默越权）` 开头的整段替换为：

```markdown
子串匹配放在 Python 侧而不是拼进 SQL 的 `LIKE`：`%` 与 `_` 在 `LIKE` 里是通配符，用户输入一个 `%` 就等于"匹配全库"，5 张卡会变成随机 5 条历史。改成取出行之后 `fragment in body` 比对，用户输入不是模式，这个后门不存在。SQL 里只剩 `WHERE user_id = ?` 与 `session_id <> ?` 两个绑定参数。代价是按用户取全表行 —— 本版语料只有需求原话与文件名（实测本地 12 条会话合计 310 字符），且已实测 LIKE 扫 1000 行 / 6 MB 只要 7.6 ms，量级上无风险。验收断言"输入 `%` 不得返回全库"保留，测的正是"确实没有模式语义"。
```

- [ ] **Step 3: 提交**

```bash
git add docs/SDD/rag-mvp/SDD.md
git commit -m "docs(rag-mvp): 开关判据处移到 fetchRagSection，子串匹配从 SQL LIKE 改到 Python 侧"
```

---

## Task 1: `rag_doc` 表 + 切片/打分纯函数

**Files:**
- Modify: `packages/server/app/database.py:21-63`（DDL 块）、`:74`（末尾）
- Create: `packages/server/app/rag.py`
- Test: `node_modules/.scratch/rag_check.py`

- [ ] **Step 1: 写失败的断言**

新建 `node_modules/.scratch/rag_check.py`。头部照抄 `auth_check.py` 的骨架（`APP_DB_PATH` 指临时库、`sys.path.insert`、`ok()/group()` 两个助手、结尾打 `ALL PASS` 与 `CHECKS` 计数），组 1 内容如下：

```python
import asyncio  # noqa: F401  (与 auth_check 同形，后面组用得到)
import os
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except (AttributeError, OSError):
    pass

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "packages", "server"))

TMP_DB = os.path.join(tempfile.gettempdir(), "rag_check.db")
for suffix in ("", "-wal", "-shm"):
    try:
        os.remove(TMP_DB + suffix)
    except OSError:
        pass
os.environ["APP_DB_PATH"] = TMP_DB
os.environ["LLM_BASE_URL"] = "http://127.0.0.1:9"   # 本脚本一律不打真实上游

import httpx  # noqa: E402
from app.main import app  # noqa: E402
from app.database import get_connection  # noqa: E402
from app.rag import split_fragments, cap, score_row, BODY_CHAR_CAP  # noqa: E402

FAILS = []
CHECKS = 0


def ok(cond, label):
    global CHECKS
    CHECKS += 1
    if not cond:
        FAILS.append(label)
        print(f"  FAIL  {label}")
    return cond


def group(name):
    print(f"\n== {name}")


def check_pure():
    group("1 切片与打分（纯函数，不碰库）")
    # 全角标点必须切得开：用户原话里的逗号几乎都是全角的
    ok(split_fragments("做一个杭州天气+周边咖啡店的落地页,数据要真实")
       == ["做一个杭州天气+周边咖啡店的落地页", "数据要真实"],
       "半角逗号切分")
    ok(split_fragments("今天天气好吗？北京吧") == ["今天天气好吗", "北京吧"], "全角问号切分")
    ok(split_fragments("你好") == ["你好"], "2 字片段保留（LIKE 不受 trigram 的 >=3 限制）")
    ok(split_fragments("好") == [], "1 字片段丢弃")
    ok(len(split_fragments("、".join(["片段" + str(i) for i in range(20)]))) == 8,
       "片段数上限 8")
    ok(split_fragments("") == [] and split_fragments("   ") == [], "空输入不抛异常")
    ok(cap("x" * 400) == "x" * BODY_CHAR_CAP, "body 截到天花板")
    ok(score_row("requirement", ["天气"], "看一下佛山的天气") == 2, "需求原话命中算 2 倍")
    ok(score_row("path", ["天气"], "index.html") == 0, "没命中就是 0")
    ok(score_row("path", ["index"], "index.html") == 1, "文件名命中算 1，不加权")
    # 这是"后门不存在"的正证：用户输入 % 时不得匹配到任何不含 % 的行
    ok(score_row("requirement", ["%"], "做一个待办应用") == 0, "% 不是通配符")
    ok(score_row("requirement", ["_"], "做一个待办应用") == 0, "_ 不是通配符")


if __name__ == "__main__":
    check_pure()
    print(f"\n{'ALL PASS' if not FAILS else 'FAILURES: ' + str(len(FAILS))}  ({CHECKS} checks)")
    sys.exit(0 if not FAILS else 1)
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd packages/server && APP_DB_PATH=/tmp/rag_check.db "/c/Users/huangwenshi/AppData/Local/Programs/Python/Python312/python.exe" ../../node_modules/.scratch/rag_check.py`
Expected: `ModuleNotFoundError: No module named 'app.rag'`（脚本第 15 行 import 就挂）

- [ ] **Step 3: 写 `packages/server/app/rag.py` 的前半**

```python
"""历史参考检索的语料与查询。见 docs/SDD/rag-mvp/SDD.md。

只索引两样东西：用户说过的原话（kind='requirement'）与会话里的文件名（kind='path'）。
代码正文不进索引 —— 本版的目标是把"索引→检索→注入→可开关"四个接缝走通，不做正文召回。
"""

import json
import re
from datetime import datetime, timezone

# 标点与空白。中文标点必须一起列进来 —— 用户原话里的逗号几乎都是全角的。
_SPLIT_RE = re.compile(r"[，。？！、,.!?;；:：\s]+")
MAX_FRAGMENTS = 8
MIN_FRAGMENT_LEN = 2

# 极宽松的天花板：它唯一防的是有人把整份 PRD 粘成一句话。见 SDD"实测依据"一节 ——
# 5 条用满是 800 字符 ≈ 267 token = 软限的 0.4%，不值得为它写压缩逻辑，所以这个值不需要调准。
BODY_CHAR_CAP = 160


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def cap(text: str) -> str:
    return text[:BODY_CHAR_CAP]


def split_fragments(query: str) -> list[str]:
    """用户原话不是搜索词：整句去做子串匹配永远命中不了，必须先切。"""
    out: list[str] = []
    for piece in _SPLIT_RE.split(query):
        p = piece.strip()
        if len(p) >= MIN_FRAGMENT_LEN:
            out.append(p)
    return out[:MAX_FRAGMENTS]


def score_row(kind: str, frags: list[str], body: str) -> int:
    """命中片段数；需求原话算 2 倍权重，文件名不加权 —— 本地实测 5 个文件全叫
    index.html，信息量为零，给权重只会搅乱结果。

    子串匹配刻意留在 Python 而不是拼进 SQL 的 LIKE：'%' 与 '_' 在 LIKE 里是通配符，
    放进模式就等于给用户开"一个字符读走全库"的后门。这里它只是普通字符。
    """
    hits = sum(1 for f in frags if f in body)
    if hits == 0:
        return 0
    return hits * 2 if kind == "requirement" else hits
```

- [ ] **Step 4: 跑，确认通过**

同上命令。Expected: `ALL PASS  (12 checks)`

- [ ] **Step 5: 加 DDL**

`packages/server/app/database.py` 的 `conn.executescript("""...""")` 块内，`idx_auth_tokens_user` 那行之后追加：

```sql
        CREATE TABLE IF NOT EXISTS rag_doc (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            kind TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_rag_doc_user ON rag_doc(user_id, kind);
```

- [ ] **Step 6: 断言表存在**

`rag_check.py` 的 `check_pure()` 之后加：

```python
def check_schema():
    group("2 表与级联")
    conn = get_connection()
    cols = {r[1] for r in conn.execute("PRAGMA table_info(rag_doc)").fetchall()}
    ok(cols == {"id", "user_id", "session_id", "kind", "body", "created_at"}, f"rag_doc 列齐全，实际 {cols}")
    fks = conn.execute("PRAGMA foreign_key_list(rag_doc)").fetchall()
    ok(any(f[2] == "sessions" and f[6] == "DELETE" and f[7] == "CASCADE" for f in fks),
       "session_id 外键带 ON DELETE CASCADE（这是本特性唯一的越权风险点）")
    conn.close()
```

`__main__` 里 `check_pure()` 下面加 `check_schema()`。

- [ ] **Step 7: 跑，确认通过并提交**

Expected: `ALL PASS`（组 1 的 12 项 + 组 2 的 2 项）

```bash
git add packages/server/app/rag.py packages/server/app/database.py
git commit -m "feat(rag-mvp): rag_doc 表与切片打分的纯函数"
```

---

## Task 2: `sync_session_docs` + 启动回填

**Files:**
- Modify: `packages/server/app/rag.py`（追加）
- Modify: `packages/server/app/database.py:74`（`init_db` 末尾）
- Test: `node_modules/.scratch/rag_check.py`

- [ ] **Step 1: 写失败的断言**

```python
def check_sync():
    group("3 索引同步与回填")
    from app.rag import sync_session_docs, backfill_if_empty

    conn = get_connection()
    now = "2026-10-03T00:00:00+00:00"
    conn.execute("INSERT INTO users (id, username, pass_hash, created_at) VALUES ('u1','a1','x',?)", (now,))
    conn.execute("INSERT INTO users (id, username, pass_hash, created_at) VALUES ('u2','a2','x',?)", (now,))
    conn.execute("INSERT INTO sessions (id,title,created_at,updated_at,user_id) VALUES ('s1','天气',?,?,?)", (now, now, "u1"))
    conn.execute("INSERT INTO sessions (id,title,created_at,updated_at,user_id) VALUES ('s2','计算器',?,?,?)", (now, now, "u1"))
    conn.execute("INSERT INTO sessions (id,title,created_at,updated_at) VALUES ('s_legacy','存量无主',?,?)", (now, now))
    for content in ["看一下佛山的天气", "天津呢", "   "]:
        conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1','user',?,?)",
            (content, now),
        )
    conn.execute("INSERT INTO messages (session_id, role, content, created_at) VALUES ('s1','assistant','好的',?)", (now,))
    conn.execute("INSERT INTO workspaces (session_id, files) VALUES ('s1', ?)",
                 ('{"index.html": "<html>天气</html>", "style.css": "body{}"}',))
    conn.execute("INSERT INTO workspaces (session_id, files) VALUES ('s2', ?)", ("not-json",))
    conn.commit()

    n = sync_session_docs(conn, "u1", "s1")
    reqs = conn.execute("SELECT body FROM rag_doc WHERE session_id='s1' AND kind='requirement'").fetchall()
    paths = conn.execute("SELECT body FROM rag_doc WHERE session_id='s1' AND kind='path'").fetchall()
    ok([r[0] for r in reqs] == ["看一下佛山的天气", "天津呢"], f"空白 user 消息不入索引，实际 {[r[0] for r in reqs]}")
    ok(len(reqs) == 2 and len(paths) == 2, "需求原话 2 条 + 文件名 2 条")
    ok(conn.execute("SELECT count(*) FROM rag_doc WHERE body LIKE '%好的%'").fetchone()[0] == 0,
       "assistant 的话不入索引（检索词只该来自用户原话）")
    kinds = {r[0] for r in conn.execute("SELECT DISTINCT kind FROM rag_doc").fetchall()}
    ok(kinds == {"requirement", "path"}, f"只有这两种 kind，实际 {kinds}")
    ok(n == 4, f"返回值是写入行数 4，实际 {n}")

    # 幂等：再来一次不得累积
    sync_session_docs(conn, "u1", "s1")
    ok(conn.execute("SELECT count(*) FROM rag_doc WHERE session_id='s1'").fetchone()[0] == 4,
       "重复同步不累积（全删全插）")

    # 坏 blob 不能把整次写入带走
    sync_session_docs(conn, "u1", "s2")
    ok(conn.execute("SELECT count(*) FROM rag_doc WHERE session_id='s2'").fetchone()[0] == 0,
       "workspace blob 坏掉 → 只丢文件名，不抛异常")

    conn.execute("DELETE FROM rag_doc")
    conn.commit()
    total = backfill_if_empty(conn)
    ok(conn.execute("SELECT count(*) FROM rag_doc WHERE session_id='s_legacy'").fetchone()[0] == 0,
       "user_id IS NULL 的存量行不进索引（NULL 归属谁都不属于）")
    ok(total > 0, "回填确实写了行")
    again = backfill_if_empty(conn)
    ok(again == 0, "表非空时回填直接返回 0，不重扫")

    # 级联
    conn.execute("DELETE FROM sessions WHERE id='s1'")
    conn.commit()
    ok(conn.execute("SELECT count(*) FROM rag_doc WHERE session_id='s1'").fetchone()[0] == 0,
       "删会话不留孤儿索引行（否则 B 能搜到 A 已删的需求原话）")
    conn.close()
```

- [ ] **Step 2: 跑，确认失败**

Run: `cd packages/server && APP_DB_PATH=/tmp/rag_check.db "/c/.../python.exe" ../../node_modules/.scratch/rag_check.py`
Expected: `ImportError: cannot import name 'sync_session_docs'`

- [ ] **Step 3: 实现**

`packages/server/app/rag.py` 末尾追加：

```python
def sync_session_docs(conn, user_id: str, session_id: str) -> int:
    """该会话名下全删全插。幂等，所以两个调用点重复触发不会累积。

    json.loads 只发生在这一个会话的 blob 上（实测单 blob 最大 18,281 字符），不是全库 ——
    这是本方案在内存上比"现扫全库"安全的确切原因。
    """
    conn.execute("DELETE FROM rag_doc WHERE session_id = ?", (session_id,))
    written = 0
    rows = conn.execute(
        "SELECT content, created_at FROM messages "
        "WHERE session_id = ? AND role = 'user' ORDER BY id ASC",
        (session_id,),
    ).fetchall()
    for r in rows:
        content = (r["content"] or "").strip()
        if not content:
            continue
        conn.execute(
            "INSERT INTO rag_doc (user_id, session_id, kind, body, created_at) "
            "VALUES (?, ?, 'requirement', ?, ?)",
            (user_id, session_id, cap(content), r["created_at"]),
        )
        written += 1
    ws = conn.execute("SELECT files FROM workspaces WHERE session_id = ?", (session_id,)).fetchone()
    if ws:
        try:
            paths = list(json.loads(ws["files"]).keys())
        except (TypeError, ValueError):
            paths = []  # 坏 blob 不值得把整次写入带走：少一路文件名命中而已
        now = _now()
        for p in paths:
            conn.execute(
                "INSERT INTO rag_doc (user_id, session_id, kind, body, created_at) "
                "VALUES (?, ?, 'path', ?, ?)",
                (user_id, session_id, cap(p), now),
            )
            written += 1
    return written


def backfill_if_empty(conn) -> int:
    """只在 rag_doc 整盘为空时跑一次（存量没别的办法：那时根本没写钩子）。

    `sessions.user_id IS NULL` 的存量行不进索引 —— 沿用既有不变量"NULL 归属谁都不属于"，
    不能因为它们在库里躺着就被谁检索出来。
    """
    if conn.execute("SELECT 1 FROM rag_doc LIMIT 1").fetchone() is not None:
        return 0
    total = 0
    rows = conn.execute(
        "SELECT id, user_id FROM sessions WHERE user_id IS NOT NULL"
    ).fetchall()
    for r in rows:
        total += sync_session_docs(conn, r["user_id"], r["id"])
    conn.commit()
    return total
```

- [ ] **Step 4: 挂进 `init_db()`**

`packages/server/app/database.py` 中，两个 `try/except ALTER` 之后、`conn.close()` 之前插入：

```python
    # 回填必须排在 ALTER 之后：它要读 sessions.user_id，而那列是上面刚补的。
    from app.rag import backfill_if_empty

    backfill_if_empty(conn)
```

（函数内 import 是有意的：`app.rag` 与 `app.database` 互相认识会成导入环，`rag.py` 本身不 import `database`，只有 `init_db` 单向取它。）

- [ ] **Step 5: 跑，确认通过并提交**

Expected: `ALL PASS`（组 1-3 全绿）

```bash
git add packages/server/app/rag.py packages/server/app/database.py
git commit -m "feat(rag-mvp): sync_session_docs 全删全插 + 启动回填，跳过无主存量行"
```

---

## Task 3: 两个写入钩子

**Files:**
- Modify: `packages/server/app/routes/sessions.py:178-184`、`:218-224`
- Test: `node_modules/.scratch/rag_check.py`

- [ ] **Step 1: 写失败的断言**

```python
async def check_hooks(client):
    group("4 落库即同步索引（两个调用点）")
    r = await client.post("/api/auth/register", json={"username": "hook1", "password": "pw-hook-1"})
    tok = (r.json())["token"]
    h = {"Authorization": f"Bearer {tok}"}
    sid = (await client.post("/api/sessions", json={"title": "钩子"}, headers=h)).json()["id"]

    ok((await client.get("/api/rag/search", params={"q": "钩子词独有", "exclude": sid}, headers=h)).json()["results"] == [],
       "新会话还没有内容")

    await client.post(f"/api/sessions/{sid}/messages",
                      json=[{"role": "user", "content": "钩子词独有ABC"}, {"role": "assistant", "content": "好"}],
                      headers=h)
    got = (await client.get("/api/rag/search", params={"q": "钩子词独有ABC", "exclude": "other"}, headers=h)).json()["results"]
    ok(len(got) == 1 and got[0]["requirement"] == "钩子词独有ABC", f"messages POST 之后可检索到，实际 {got}")

    r2 = await client.post("/api/sessions", json={"title": "钩子2"}, headers=h)
    sid2 = r2.json()["id"]
    await client.post(f"/api/sessions/{sid2}/messages",
                      json=[{"role": "user", "content": "第二会话独有XYZ"}], headers=h)
    await client.put(f"/api/sessions/{sid2}/workspace",
                     json={"files": {"独有文件名weather.html": "<html/>"}}, headers=h)
    got2 = (await client.get("/api/rag/search", params={"q": "独有文件名weather", "exclude": "other"}, headers=h)).json()["results"]
    ok(any("独有文件名weather.html" in c["paths"] for c in got2),
       f"workspace PUT 之后文件名可检索，实际 {got2}")
```

`__main__` 改成有 client 的异步入口（照 `auth_check.py` 的 `async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c`）：

```python
async def amain():
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        check_pure()
        check_schema()
        check_sync()
        await check_hooks(c)
    print(f"\n{'ALL PASS' if not FAILS else 'FAILURES: ' + str(len(FAILS))}  ({CHECKS} checks)")
    sys.exit(0 if not FAILS else 1)


if __name__ == "__main__":
    asyncio.run(amain())
```

- [ ] **Step 2: 跑，确认失败**

Expected: 组 4 前两条 FAIL —— 落库后 `rag_doc` 里没有行（端点还不存在时会先 404，也是 FAIL）

- [ ] **Step 3: 实现两个调用点**

`packages/server/app/routes/sessions.py` 顶部 import 段加：

```python
from app.rag import sync_session_docs
```

`add_messages` 里，`UPDATE sessions SET updated_at` 那条 `conn.execute` 之后、`conn.commit()` 之前：

```python
    # 索引跟着正文一起落地。两个调用点都写：整轮结束时 saveMessages 与 saveWorkspace 的
    # 先后顺序前端没有保证，只挑一个就会出现"改了文件结构但卡片里的文件名还是上一轮的"。
    sync_session_docs(conn, user.id, session_id)
```

`update_workspace` 里同样位置（`UPDATE sessions SET updated_at` 之后、`conn.commit()` 之前）加同一行：

```python
    sync_session_docs(conn, user.id, session_id)
```

- [ ] **Step 4: 跑，确认通过**

Expected: `ALL PASS`（组 1-4 全绿；若组 4 仍 FAIL 而端点未写，先做完 Task 4 再回跑）

- [ ] **Step 5: 提交**

```bash
git add packages/server/app/routes/sessions.py
git commit -m "feat(rag-mvp): messages 与 workspace 两处落库后同步 rag 索引"
```

---

## Task 4: `search()` + `GET /api/rag/search`

**Files:**
- Modify: `packages/server/app/rag.py`（追加）
- Create: `packages/server/app/routes/rag.py`
- Modify: `packages/server/app/main.py:5-11`、`:28-35`
- Test: `node_modules/.scratch/rag_check.py`

- [ ] **Step 1: 写失败的断言**

```python
async def check_search(client):
    group("5 检索契约")
    r = await client.post("/api/auth/register", json={"username": "srch", "password": "pw-srch-1"})
    h = {"Authorization": f"Bearer {r.json()['token']}"}
    sids = []
    for title, req in [("天气A", "看一下佛山的天气"), ("天气B", "天津呢 上海天气"),
                       ("计算器", "帮我做一个计算器"), ("天气C", "青岛天气好吗")]:
        sid = (await client.post("/api/sessions", json={"title": title}, headers=h)).json()["id"]
        sids.append(sid)
        await client.post(f"/api/sessions/{sid}/messages", json=[{"role": "user", "content": req}], headers=h)
        await client.put(f"/api/sessions/{sid}/workspace", json={"files": {"index.html": "<html/>"}}, headers=h)

    async def search(q, exclude=""):
        j = (await client.get("/api/rag/search", params={"q": q, "exclude": exclude}, headers=h)).json()
        return j["results"]

    res = await search("看下北京天气")
    ok(all(c["sessionId"] != sids[2] for c in res), f"不相关的会话不进结果，实际 {[c['sessionId'] for c in res]}")
    ok(len(res) == 3, f"三条天气会话都该命中，实际 {len(res)}")
    ok([c["sessionId"] for c in res] == [sids[1], sids[3], sids[0]],
       f"命中片段多的优先、并列时近的优先，实际 {[c['sessionId'] for c in res]}")
    ok(all(len(c["paths"]) <= 1 and "index.html" in c["paths"] for c in res), "卡片带文件名")

    # 去重在 LIMIT 之前：一条会话三个片段全命中也只出一张卡
    sid_multi = (await client.post("/api/sessions", json={"title": "多轮"}, headers=h)).json()["id"]
    await client.post(f"/api/sessions/{sid_multi}/messages",
                      json=[{"role": "user", "content": "杭州天气"}, {"role": "user", "content": "杭州咖啡"},
                            {"role": "user", "content": "杭州地铁"}], headers=h)
    res2 = await search("杭州 天气 咖啡 地铁")
    ok(sum(1 for c in res2 if c["sessionId"] == sid_multi) == 1, "同一会话只留最高分那一条")

    # exclude
    res3 = await search("杭州 天气 咖啡 地铁", exclude=sid_multi)
    ok(all(c["sessionId"] != sid_multi for c in res3), "exclude 生效（正在生成的这条不自己抄自己）")

    # 通配符后门
    res4 = await search("%")
    ok(res4 == [], f"输入 % 不得返回全库，实际 {len(res4)} 条")
    res5 = await search("_")
    ok(res5 == [], f"输入 _ 不得返回全库，实际 {len(res5)} 条")

    # 短查询：切片后无有效片段就直接空
    ok(await search("好") == [], "1 字查询不检索")
    ok(await search("") == [], "空查询不检索")

    group("6 越权与收口")
    r2 = await client.post("/api/auth/register", json={"username": "oth", "password": "pw-oth-1"})
    h2 = {"Authorization": f"Bearer {r2.json()['token']}"}
    other = (await client.get("/api/rag/search", params={"q": "佛山的天气", "exclude": "x"}, headers=h2)).json()
    ok(other["results"] == [], f"别人的账号搜不到别人的需求原话，实际 {other['results']}")
    ok((await client.get("/api/rag/search", params={"q": "天气"})).status_code == 401, "未登录 401")
    ok((await client.get("/api/rag/search", params={"q": "天气", "exclude": "x"}, headers={"Authorization": "Bearer nope"})).status_code == 401,
       "失效 token 401")

    group("7 不进每日额度计数")
    from app.spend_log import snapshot, record_spend
    before = snapshot()
    await client.get("/api/rag/search", params={"q": "天气", "exclude": "x"}, headers=h)
    after = snapshot()
    ok(after == before, f"rag_search 不产生记账，实际 {before} → {after}")
```

- [ ] **Step 2: 跑，确认失败**

Expected: 404（路由不存在），组 5 全 FAIL

- [ ] **Step 3: 实现 `search()`**

`packages/server/app/rag.py` 末尾追加：

```python
def search(conn, user_id: str, query: str, exclude_session: str, limit: int = 5) -> list[dict]:
    """top-k 卡片。返回 [{sessionId, title, requirement, paths, score}]，前端只管拼文本。"""
    frags = split_fragments(query)
    if not frags:
        return []
    rows = conn.execute(
        "SELECT d.session_id, d.kind, d.body, d.created_at, s.title "
        "FROM rag_doc d JOIN sessions s ON s.id = d.session_id "
        "WHERE d.user_id = ? AND d.session_id <> ?",
        (user_id, exclude_session),
    ).fetchall()

    best: dict[str, dict] = {}
    req_by_session: dict[str, str] = {}
    paths_by_session: dict[str, list[str]] = {}
    for r in rows:
        sid = r["session_id"]
        if r["kind"] == "path":
            paths_by_session.setdefault(sid, []).append(r["body"])
        elif sid not in req_by_session:
            req_by_session[sid] = r["body"]
        sc = score_row(r["kind"], frags, r["body"])
        if sc == 0:
            continue
        cur = best.get(sid)
        if cur is None or sc > cur["score"] or (sc == cur["score"] and r["created_at"] > cur["created_at"]):
            best[sid] = {
                "sessionId": sid,
                "title": r["title"],
                "kind": r["kind"],
                "matched": r["body"],
                "score": sc,
                "created_at": r["created_at"],
            }

    # 排序与 LIMIT 的顺序有讲究：先按会话取最高分，再截 5 条。反过来的话 5 张卡
    # 会全是同一个会话的不同片段，用户看到"提了 5 遍天气"而不是"做过 5 件事"。
    ranked = sorted(best.values(), key=lambda x: (x["score"], x["created_at"]), reverse=True)
    cards = []
    for hit in ranked[:limit]:
        sid = hit["sessionId"]
        cards.append({
            "sessionId": sid,
            "title": hit["title"],
            # 卡片取文规则：最高分落在 path 时，仍优先显示该会话的一条需求原话。
            "requirement": hit["matched"] if hit["kind"] == "requirement" else req_by_session.get(sid, ""),
            "paths": paths_by_session.get(sid, []),
            "score": hit["score"],
        })
    return cards
```

- [ ] **Step 4: 实现路由**

新建 `packages/server/app/routes/rag.py`：

```python
"""历史参考检索的 HTTP 壳。鉴权不在这里写 —— main.py 给 /api/* 整组挂了 Depends(current_user)，
所以 user_id 只能从 token 解，永远不接受客户端传参。"""

from fastapi import APIRouter, Depends, Query

from app.auth import AuthUser, current_user
from app.database import get_connection
from app.rag import search

router = APIRouter(prefix="/api/rag", tags=["rag"])


@router.get("/search")
def rag_search(
    q: str = Query(default=""),
    exclude: str = Query(default=""),
    limit: int = Query(default=5, ge=1, le=20),
    user: AuthUser = Depends(current_user),
):
    conn = get_connection()
    try:
        return {"results": search(conn, user.id, q, exclude, limit)}
    finally:
        conn.close()
```

`packages/server/app/main.py`：import 段（`from app.routes.mcp import ...` 之后）加

```python
from app.routes.rag import router as rag_router
```

`app.include_router(voice_router)` 之前加

```python
app.include_router(rag_router, dependencies=AUTH)
```

- [ ] **Step 5: 跑，确认全绿**

Run: `cd packages/server && APP_DB_PATH=/tmp/rag_check.db "/c/.../python.exe" ../../node_modules/.scratch/rag_check.py`
Expected: `ALL PASS`，checks 数 ≥ 40

- [ ] **Step 6: 提交**

```bash
git add packages/server/app/rag.py packages/server/app/routes/rag.py packages/server/app/main.py
git commit -m "feat(rag-mvp): 子串打分检索 + GET /api/rag/search（会话去重在 LIMIT 前）"
```

---

## Task 5: 前端 `rag` provider（开关 + 卡片文本化）

**Files:**
- Modify: `packages/web/src/agent/types.ts:13`
- Create: `packages/web/src/agent/providers/rag.ts`
- Test: `packages/web/src/agent/__tests__/ragProvider.test.ts`

- [ ] **Step 1: 写失败的单测**

新建 `packages/web/src/agent/__tests__/ragProvider.test.ts`。localStorage 的测试替身照 `capabilityStore.test.ts` 里现成的做法（该文件已在测 `capabilities-enabled`，不要另发明一套）。

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRagSection, fetchRagSection, lastUserQuery, RAG_SOURCE_ID } from '../providers/rag'
import { setSourceEnabled } from '../capabilityStore'
import type { RagCard } from '../providers/rag'

const card = (over: Partial<RagCard> = {}): RagCard => ({
  sessionId: 's1', title: '天气A', requirement: '看一下佛山的天气', paths: ['index.html'], ...over,
})

describe('buildRagSection', () => {
  it('空结果就是空串，不写"没有找到历史参考"', () => {
    expect(buildRagSection([])).toBe('')
  })

  it('卡片带原话与文件名，并带那句划界文案', () => {
    const s = buildRagSection([card()])
    expect(s).toContain('不是本次需求的一部分')
    expect(s).toContain('看一下佛山的天气')
    expect(s).toContain('文件: index.html')
    expect((s.match(/不是本次需求的一部分/g) ?? []).length).toBe(1)
  })

  it('无需求原话时退回会话标题', () => {
    const s = buildRagSection([card({ requirement: '', title: '天气落地页' })])
    expect(s).toContain('天气落地页')
  })

  it('以 \n\n 起头，拼在 system 正文后面不会黏成一坨', () => {
    expect(buildRagSection([card()]).startsWith('\n\n')).toBe(true)
  })
})

describe('lastUserQuery', () => {
  it('取最后一条有文字的 user 消息', () => {
    expect(lastUserQuery([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '第二条' },
    ])).toBe('第二条')
  })

  it('跳过空白与多模态（content 不是字符串）的那条，继续往前找', () => {
    expect(lastUserQuery([
      { role: 'user', content: '可用的文字' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '   ' },
      { role: 'user', content: [{ type: 'text', text: '不是字符串形状' }] },
    ])).toBe('可用的文字')
  })

  it('一条都没有时返回空串', () => {
    expect(lastUserQuery([{ role: 'assistant', content: '好' }])).toBe('')
  })
})

describe('fetchRagSection 的开关与降级', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    localStorage.clear()
  })

  it('开关关着时一个请求也不发（判据处只有这一处读 store）', async () => {
    setSourceEnabled(RAG_SOURCE_ID, false)
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('查询为空时不发请求', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    await expect(fetchRagSection('   ', 's1')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('5xx 静默降级为空串，不抛', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
  })

  it('坏 JSON 静默降级', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response('<html>SPA 外壳</html>', { status: 200 }))
    await expect(fetchRagSection('佛山天气', 's1')).resolves.toBe('')
  })

  it('畸形条目被逐条丢掉而不是整体崩', async () => {
    setSourceEnabled(RAG_SOURCE_ID, true)
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      results: [card(), { sessionId: 1 }, null, { sessionId: 's2', title: 'x' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const s = await fetchRagSection('佛山天气', 's1')
    expect(s).toContain('看一下佛山的天气')
    expect(s).not.toContain('"sessionId":1')
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter web test:run`
Expected: `Failed to resolve import "../providers/rag"`

- [ ] **Step 3: 扩 `CapabilityKind`**

`packages/web/src/agent/types.ts` 第 13 行：

```ts
/** 能力的提供方。管道（发现→注册→开关→面板→进度→错误）两边共用，语义差异见 durability / effect。 */
export type CapabilityKind = 'mcp' | 'skill'
```

改为：

```ts
/** 能力的提供方。管道（发现→注册→开关→面板→进度→错误）共用；rag 这一家只有开关、没有工具定义。 */
export type CapabilityKind = 'mcp' | 'skill' | 'rag'
```

- [ ] **Step 4: 写 `packages/web/src/agent/providers/rag.ts`**

```ts
import type { CapabilitySourceInfo } from '../types'
import { applyProviderSources, isSourceEnabled } from '../capabilityStore'
import { authFetch } from '../../api/auth'

/**
 * 历史参考（RAG）provider。与 MCP / 技能两家的根本差别：**它不注册任何工具**。
 * 检索由每轮生成无条件发起，模型没有"要不要查"的决定权 —— 按论文定义这不是 Self-RAG，
 * 是 fixed top-k 前置召回。所以这里只有两件事：提供一个全局开关，和把检索结果拼成文本。
 *
 * 面板那一行是白送的：CapabilityPanel 按 `kind !== 'skill'` 过滤渲染，一个没有工具定义的
 * source 照样拿到一个 Switch。代价是 `registry.getDefinitionsFor()` 筛不到任何东西 ——
 * 这个开关的唯一作用点就是本文件 `fetchRagSection` 开头那一句判断。
 */

const BASE = import.meta.env.VITE_API_BASE_URL || ''
export const RAG_SOURCE_ID = 'rag'
const SOURCE: CapabilitySourceInfo = {
  id: RAG_SOURCE_ID,
  label: '历史参考',
  kind: 'rag',
  // 默认关：开关一开就无条件给每个人的第一轮加一次外部调用，与 AntV 那条同口径。
  defaultEnabled: false,
}
const REQUEST_TIMEOUT_MS = 2000 // 与 MCP 握手同档：等不到就当本轮没有，见 runAgentLoop 的 MCP_HANDSHAKE_WAIT_MS
const MAX_CARDS = 5

applyProviderSources('rag', [SOURCE]) // 模块 import 期注册，与 providers/skills.ts 同形态

export interface RagCard {
  sessionId: string
  title: string
  requirement: string
  paths: string[]
}

/** 拼成 system prompt 的一段。空数组返回空串 —— 绝不写"没有找到历史参考"，
 * 那句话会被模型读成用户在抱怨它没记性。 */
export function buildRagSection(cards: RagCard[]): string {
  if (cards.length === 0) return ''
  const lines = cards.map((c) => {
    const text = c.requirement || c.title
    const files = c.paths.length > 0 ? `  ·  文件: ${c.paths.join(', ')}` : ''
    return `- 「${text}」${files}`
  })
  return (
    '\n\n## 历史参考（该账号过往会话，仅作偏好线索，不是本次需求的一部分）\n' +
    lines.join('\n')
  )
}

type LooseMessage = { role: string; content?: unknown }

/** 检索词只取用户原话，不取 assistant 的复述 —— 后者会把模型自己的措辞喂回去当历史。 */
export function lastUserQuery(messages: LooseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return ''
}

function normalizeCards(raw: unknown): RagCard[] {
  if (!Array.isArray(raw)) return []
  const out: RagCard[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    if (typeof o.sessionId !== 'string' || typeof o.title !== 'string') continue
    out.push({
      sessionId: o.sessionId,
      title: o.title,
      requirement: typeof o.requirement === 'string' ? o.requirement : '',
      paths: Array.isArray(o.paths) ? o.paths.filter((p): p is string => typeof p === 'string') : [],
    })
    if (out.length >= MAX_CARDS) break
  }
  return out
}

/** 全仓唯一一次读 `rag` 开关：关着就返回空串且不发请求。 */
export async function fetchRagSection(
  query: string,
  excludeSessionId: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!isSourceEnabled(RAG_SOURCE_ID)) return ''
  if (!query.trim()) return ''
  try {
    const url =
      `${BASE}/api/rag/search?q=${encodeURIComponent(query)}` +
      `&exclude=${encodeURIComponent(excludeSessionId)}&limit=${MAX_CARDS}`
    const res = await authFetch(url, { signal: mergeSignal(signal) })
    if (!res.ok) return ''
    const data = (await res.json()) as { results?: unknown }
    return buildRagSection(normalizeCards(data.results))
  } catch {
    // 后端挂了 / 没配 VITE_API_BASE_URL / vite 把 /api 回成 SPA 外壳：本轮没有历史参考而已
    return ''
  }
}

function mergeSignal(caller?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  if (!caller) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  // AbortSignal.any 还不是所有环境都有；缺了就只受 2s 上限约束（调用方 abort 由
  // runAgentLoop 在 round 顶部 break 兜住，不会白跑一轮生成）
  return anyFn ? anyFn([caller, timeout]) : timeout
}
```

- [ ] **Step 5: 跑，确认通过**

Run: `pnpm --filter web test:run`
Expected: 新增 13 条全绿，原有 130 条不回归（共 143）。若 `capabilityStore` 的快照测试因新增 kind 断言了 source 条数而红，那是**该测试写死了清单**，按实际情况放宽到"至少包含 mcp 那几条"，不要为了绿而删断言。

- [ ] **Step 6: 提交**

```bash
git add packages/web/src/agent/types.ts packages/web/src/agent/providers/rag.ts packages/web/src/agent/__tests__/ragProvider.test.ts
git commit -m "feat(rag-mvp): rag capability source 与卡片文本化，开关默认关"
```

---

## Task 6: 接进 `runAgentLoop`（循环外一次）+ 给主循环建首个单测

**Files:**
- Modify: `packages/web/src/agent/runAgentLoop.ts:11-12`、`:31-38`、`:66`、`:82-87`
- Test: `packages/web/src/agent/__tests__/runAgentLoopRag.test.ts`

这一步要证的正是 SDD 里那条最容易写错的地方：`runAgentLoop.ts:82-88` 每轮都重写 system 正文，检索若写在 `buildSystemPrompt` 里面，一轮 5 步工具调用就是 5 次 HTTP 往返。AGENTS.md 坑 5 明说主循环零单测，这个断言用浏览器探针很难抓（一次生成中间态只存在几秒），所以这里顺手把桩建起来 —— 它只测"检索被调了几次"与"结果是否落进 payload"，不去覆盖整条工具循环。

- [ ] **Step 1: 写失败的单测**

新建 `packages/web/src/agent/__tests__/runAgentLoopRag.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchRagSection = vi.fn()
const streamChat = vi.fn()

vi.mock('../providers/rag', () => ({
  fetchRagSection: (...args: unknown[]) => fetchRagSection(...args),
  RAG_SOURCE_ID: 'rag',
}))
// 主循环会 import providers/skills 与 providers/mcp（模块期副作用），这里全部换成哑的，
// 否则一场测试要真去握手 MCP、拉技能目录。
vi.mock('../providers/mcp', () => ({ mcpCapabilitiesReady: () => Promise.resolve() }))
vi.mock('../providers/skills', () => ({ buildSkillIndexSection: () => '' }))
vi.mock('../llm/router', () => ({ streamChat: (...args: unknown[]) => streamChat(...args) }))
vi.mock('../toolRegistry', () => ({
  registry: {
    getDefinitionsFor: () => [],
    executeDetailed: async () => ({ text: 'ok', isError: false }),
  },
}))
vi.mock('../../store/workspaceStore', () => ({
  useWorkspaceStore: { getState: () => ({ filesFor: () => ({}) }) },
}))

import { runAgentLoop } from '../runAgentLoop'

/** 第 1 轮吐一个函数调用逼出第 2 轮，第 2 轮纯文本收尾。 */
function scriptedStream() {
  let call = 0
  return async function* fakeStream() {
    call += 1
    if (call === 1) {
      yield { delta: '', done: false, tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"index.html"}' } },
      ] }
      return
    }
    yield { delta: '好了', done: true }
  }
}

describe('runAgentLoop 的历史参考注入', () => {
  beforeEach(() => {
    fetchRagSection.mockReset().mockResolvedValue('\n\n## 历史参考\n- 「佛山天气」')
    streamChat.mockReset().mockImplementation(scriptedStream())
  })

  it('多轮生成里只检索一次', async () => {
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5 },
    )
    expect(fetchRagSection).toHaveBeenCalledTimes(1)
  })

  it('检索词是用户那句话，exclude 是发起那条会话', async () => {
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5 },
    )
    expect(fetchRagSection).toHaveBeenCalledWith('做个待办应用', 's1', expect.anything())
  })

  it('注入段进了每一轮的 payload，且每轮都在', async () => {
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 5 },
    )
    const payloads = streamChat.mock.calls.map((c) => c[0] as Array<{ role: string; content?: string }>)
    expect(payloads.length).toBeGreaterThanOrEqual(2)
    for (const p of payloads) {
      expect(p[0].role).toBe('system')
      expect(p[0].content).toContain('历史参考')
      expect(p[0].content).toContain('佛山天气')
    }
  })

  it('检索返回空串时 system 里不出现历史参考段', async () => {
    fetchRagSection.mockResolvedValue('')
    await runAgentLoop(
      [{ role: 'user', content: '做个待办应用' }],
      { sessionId: 's1', maxRounds: 2 },
    )
    const first = streamChat.mock.calls[0][0] as Array<{ content?: string }>
    expect(first[0].content).not.toContain('历史参考')
  })
})
```

- [ ] **Step 2: 跑，确认失败**

Run: `pnpm --filter web test:run`
Expected: 4 条里前三条 FAIL（`fetchRagSection` 从未被调用），最后一条可能"假绿"——空串本来就意味着段不存在，所以它不能当守卫，只作回归。

- [ ] **Step 3: 接线**

`packages/web/src/agent/runAgentLoop.ts` import 段（`buildSkillIndexSection` 那条之后）加：

```ts
// rag provider 在 import 期就把自己注册进 capabilityStore（开关面板那一行），
// 与 providers/skills 同形态；这条 import 删不得。
import { fetchRagSection, lastUserQuery } from './providers/rag'
```

`buildSystemPrompt` 签名与返回（`:31-38`）改为：

```ts
function buildSystemPrompt(files: Record<string, string>, skillIndex = '', ragSection = ''): string {
  const listing = Object.keys(files)
    .sort()
    .map((p) => `- ${p} (${files[p].length} 字符)`)
    .join('\n')
  const section = listing ? `\n\n当前工作区文件：\n${listing}` : '\n\n当前工作区为空。'
  return SYSTEM_PROMPT + section + skillIndex + ragSection
}
```

`const limits = resolveLimits()`（`:66`）之后加：

```ts
  // 历史参考：一轮一次，定在循环之外。system 正文每轮都要重算（文件清单得最新），
  // 把检索写进 buildSystemPrompt 就是 N 次往返，而且第 2 次起会把"刚生成到一半的本轮"当历史。
  // 关掉时 fetchRagSection 自己返回 ''，所以这里不再判一次开关 —— 判据只允许有一处。
  const ragSection = await fetchRagSection(lastUserQuery(messages), options.sessionId, signal)
```

循环内那次调用（`:82-87`）改为：

```ts
      if (allMessages[0]?.role === 'system') {
        allMessages[0].content = buildSystemPrompt(
          useWorkspaceStore.getState().filesFor(toolCtx.sessionId),
          buildSkillIndexSection(),
          ragSection,
        )
      }
```

- [ ] **Step 4: 跑，确认通过**

Run: `pnpm --filter web test:run`
Expected: 全绿（130 原有 + 13 ragProvider + 4 runAgentLoop = 150）。若"只检索一次"仍红，检查 `ragSection` 是不是被写进了 `buildSystemPrompt` 内部。

- [ ] **Step 5: 提交**

```bash
git add packages/web/src/agent/runAgentLoop.ts packages/web/src/agent/__tests__/runAgentLoopRag.test.ts
git commit -m "feat(rag-mvp): 每轮生成前检索一次并注入 system，主循环首次有单测守卫"
```

---

## Task 7: 全量验证与文档回填

**Files:**
- Modify: `docs/origin/26-10-3.md`
- Modify: `README.md`、`AGENTS.md`（口径同步）

- [ ] **Step 1: 三条命令全绿**

```bash
pnpm --filter web test:run     # Expected: 150 passed
pnpm build                     # Expected: tsc -b 通过；只剩既有的主 chunk 体积提示
cd packages/server && APP_DB_PATH=/tmp/rag_check.db "/c/Users/huangwenshi/AppData/Local/Programs/Python/Python312/python.exe" ../../node_modules/.scratch/rag_check.py   # Expected: ALL PASS
```

- [ ] **Step 2: 浏览器实测（离线，不发真实模型调用）**

按 AGENTS.md 坑 6 那条自建一个假 LLM 后端（`node_modules/.scratch/fake-llm.mjs` 已在，照 `cdp-skills-runtime-probe.mjs` 的用法复用），把 `VITE_API_BASE_URL` 指过去，手工核对三件事：

1. 能力面板出现"历史参考"一行，默认**关**；打开后刷新仍在（localStorage `capabilities-enabled`）。
2. 开着开关、用 A 账号先跑一轮"看一下佛山的天气"生成完，再新建会话发"帮我看看北京的天气" —— 用 CDP `Runtime.evaluate` 读 `window` 上挂的请求体，或直接看假 LLM 日志里收到的 `system` 消息，**必须包含**"历史参考"与上一句原话。
3. 生成中途翻开关 → 在飞那轮不变，下一轮才生效（SDD 的"生成中途翻开关"那格）。

假 LLM 那一路**不算真实模型调用**，在授权内。要真 key 打 qwen 才能验的东西本任务不涉及。

- [ ] **Step 3: 已知缺口的诚实记录**

下面两件本版不做也不验，回填文档时要写清楚，不要被"全绿"盖过去：

- 召回质量。本地语料 12 条会话、需求原话合计 310 字符，实测"待办/图表/登录注册"这些猜的词全 0 命中（语料里根本没有），**这套数据测不出效果**。效果结论一律标"未验证"。
- UI 交互没有自动化测试（AGENTS.md 坑 5）。面板那一行只靠 Step 2 的目视。

- [ ] **Step 4: 回填文档**

`docs/origin/26-10-3.md` 的勾选按**实测结果**打勾（未实测的一律不勾）。`README.md` 的"已知限制"与功能清单、`AGENTS.md` 的架构地图各加一行：

- README 功能清单加：`- 历史参考：每轮生成前从该账号过往会话里检索需求原话与文件名，取前 5 条注入；能力面板可开关，默认关`
- README 已知限制加：`- 历史参考只检索需求原话与文件名，搜不到代码正文，因此复用不了历史骨架；召回质量未做评估`
- AGENTS.md 架构地图 `agent/providers/` 那一段加一行 `agent/providers/rag.ts` 的职责说明，并注明**这家没有工具定义、开关的唯一作用点是 `fetchRagSection` 开头那一句**（否则下一个改这里的人会以为它是 capability 工具通道的一部分）

```bash
git add docs/origin/26-10-3.md README.md AGENTS.md
git commit -m "docs(rag-mvp): 验收回填与 README/AGENTS 口径同步"
```

- [ ] **Step 5: 停在这里，不要合并**

`feature/rag-mvp` 不合并进 `main`、不推送。这两步等用户明确点头。

---

## Self-Review

**1. Spec coverage** —— SDD 每节的落点：

| SDD 小节 | 任务 |
|---|---|
| 数据形状（DDL + `user_id` 显式 + NULL 存量跳过 + 级联） | Task 1 Step 5、Task 2 Step 3/4，断言在组 2/3 |
| `sync_session_docs` 一个函数两个调用点 | Task 2 + Task 3 |
| 启动回填 | Task 2 Step 4 |
| 检索契约（切片/权重/排序/去重先于 LIMIT/exclude） | Task 4 |
| 转义后门 | Task 1 Step 1（`%`/`_` 断言）+ Task 4 组 5，**且 Task 0 Step 2 已把方案改成 Python 匹配，风险面不存在** |
| 卡片形态与取文规则（含 path 命中回退需求原话、无 user 消息回退标题） | Task 4 Step 3 + Task 5 Step 4 |
| 开关（默认关 + 判据处唯一 + 面板白送） | Task 5；判据位置更正记在 Task 0 Step 1 |
| 循环外检索一次 | Task 6 |
| 截断后果（system 不丢） | 设计层面由"注入挂 system"保证，未写断言 —— 见下面 Step 自审缺口 |
| 降级（5xx/超时/坏 JSON 静默；中止；不进额度） | Task 5 Step 1 + Task 4 组 7 + Task 6 |
| 状态归属（不是状态、换账号不清） | Task 5 Step 4（不落 store、不写 localStorage）；无需额外代码 |
| 验收标准 5+3+2 | 组 3（删会话级联）+ 组 4 + 组 5 + 组 6 + 组 7 + Task 5/6 单测 |

**缺口两条，如实记下：**

- "硬截断不会丢掉注入段"这一格**没有自动化断言**。它靠 `hardTruncate` 保留锚点之前的 system（读代码已确认），但没测。补法：在 `contextBudget.test.ts` 加一条"构造超 hardLimit 的历史，断言返回的 messages[0] 仍是 system 且含注入段"。**列为 Task 7 之后的可选加固，不阻塞提审** —— 因为注入量实测 84 token，占硬限 0.06%，真触发那条路径需要 150k token 的历史。
- "生成中途翻开关 → 在飞那轮不受影响"只有 Task 7 Step 2 的浏览器目视，无自动化。它由"definitions/ragSection 在循环外读一次"的结构保证，与技能那家同形态，接受以人工验证收口。

**2. Placeholder scan** —— Task 7 Step 1 里 `/tmp/rag_check.db` 与 `"/c/.../python.exe"` 是缩写，执行时替换为完整路径（Task 1 Step 2 已给完整形式）。除此之外无 TBD。

**3. Type consistency** —— 交叉核对过：`sync_session_docs(conn, user_id, session_id)`（Task 2 定义 / Task 3 两处调用一致）；`backfill_if_empty(conn)`（Task 2 定义 / Task 2 Step 4 调用一致）；`search(conn, user_id, query, exclude_session, limit)`（Task 4 定义 / 路由调用一致）；卡片字段 `sessionId/title/requirement/paths/score`（Task 4 服务端产出 / Task 5 `RagCard` + `normalizeCards` 读取一致，服务端多带的 `score` 前端不读，无害）；`fetchRagSection(query, excludeSessionId, signal?)`（Task 5 定义 / Task 6 三参调用一致）；`buildSystemPrompt(files, skillIndex, ragSection)`（Task 6 改签名与调用点一致）。

---

## Execution Handoff

计划落在 `docs/SDD/rag-mvp/PLAN.md`。执行方式两选一，用户已授权"遇到问答走默认项"，故采用**推荐项：Subagent-Driven**（每个 Task 派一个新 subagent，任务之间我复核），除非用户另有指示。
