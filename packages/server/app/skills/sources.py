"""skill 通道的上游地址与 URL 构造。

与 `app/mcp/servers.py` 的关键差别：**这条通道没有任何 key**。AgentExplorer 的目录与详情端点匿名
可访（实测无 AK/SK、无签名即 200，见 docs/origin/26-9-19.md 第 1 节），`raw.githubusercontent.com`
同样匿名。所以这里不存在"鉴权头只留在服务端"的问题 —— 但也不需要因此放松任何校验。
"""

import os
import urllib.parse

import httpx

# 端点基址可覆盖，只为离线验证（假上游）留的口，与 servers.py 的 MCP_BASE_URL 同一个理由
AGENT_EXPLORER_BASE = os.environ.get("AGENT_EXPLORER_BASE", "https://agentexplorer.aliyuncs.com")
RAW_BASE = os.environ.get("SKILL_RAW_BASE", "https://raw.githubusercontent.com")

API_VERSION = "2026-03-17"
USER_AGENT = f"AlibabaCloud-Agent-Skills/{os.environ.get('SKILL_CALLER', 'huiyingyong')}"

HEADERS = {"User-Agent": USER_AGENT, "x-acs-version": API_VERSION}

# read 30s / connect 10s：与 app/mcp/client.py:43 同策略。前端那份 abort 是 35s，
# 必须严格大于这里，否则用户看到的是"什么都没有"而不是上游那句超时文案。
TIMEOUT = httpx.Timeout(30.0, connect=10.0)

GITHUB_PREFIX = "https://github.com/"


def make_client() -> httpx.AsyncClient:
    """trust_env=False：本机系统代理在做 MITM TLS，走环境代理会 UNEXPECTED_EOF（已实测）。"""
    return httpx.AsyncClient(timeout=TIMEOUT, trust_env=False, http2=False, headers=HEADERS)


def raw_base_for(github_path: str) -> str | None:
    """`https://github.com/<owner>/<repo>/tree/<ref>/<dir>` → raw 域下的同一前缀。

    实测形态（docs/origin/26-9-19.md 第 2 节）：
      .../tree/master/skills/storage/oss/alibabacloud-oss-manage-metaquery
    形状不合就返回 None —— githubPath 来自上游目录而非请求方，但它仍是拼接的原料，不校验就等于信任。
    """
    if not github_path.startswith(GITHUB_PREFIX):
        return None
    parts = github_path[len(GITHUB_PREFIX) :].split("/")
    if len(parts) < 4 or parts[2] != "tree":
        return None
    owner, repo, _tree, ref, *dirs = parts
    segments = [owner, repo, ref, *dirs]
    if any(not s or ".." in s or s.startswith(".") for s in segments):
        return None
    encoded = "/".join(urllib.parse.quote(s, safe="") for s in segments)
    return f"{RAW_BASE}/{encoded}"


def validate_reference_path(path: str) -> bool:
    """纯语法校验，不做任何 I/O —— 畸形 path 要在这里就拒掉，连目录查询都不该为它发一次请求。

    这是本特性唯一注入面的第一道闸，三条规则：
    1. 只允许 `references/` 前缀 —— 不让调用方借道取该技能目录之外的任意仓库文件；
    2. 拒绝绝对 URL、前导 `/`、`\\`、`..`、控制字符 —— 路径穿越与协议切换都在这里挡；
    3. 只允许 `.md`。
    """
    if not isinstance(path, str) or not path.startswith("references/"):
        return False
    if len(path) > 300 or "://" in path or path.startswith("/"):
        return False
    if "\\" in path or ".." in path or not path.endswith(".md"):
        return False
    return not any(ord(c) < 32 or ord(c) == 127 for c in path)


def reference_url(github_path: str, path: str) -> str | None:
    """合规 path + 该 skill 的 githubPath → raw URL；任何一步不合仍返回 None（不发请求）。

    除了再过一遍语法，还要核 githubPath 的形状（它来自上游目录，不是请求方，但仍是拼接原料），
    并在拼完之后比对 host —— 前面几条挡不住的畸形由这条兜住：能发出去的请求只有 RAW_BASE 一个主机。
    """
    if not validate_reference_path(path):
        return None
    base = raw_base_for(github_path)
    if base is None:
        return None
    url = f"{base}/{urllib.parse.quote(path, safe='/')}"
    if urllib.parse.urlsplit(url).netloc != urllib.parse.urlsplit(RAW_BASE).netloc:
        return None
    return url
