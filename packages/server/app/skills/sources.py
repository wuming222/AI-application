"""百炼 Managed Agents Skill API 的地址、鉴权与路径校验。

与 `app/mcp/servers.py` 同一条纪律：**key 只留在这里，绝不出现在任何响应体里**。
这条通道和此前那条匿名的 agentexplorer 目录最大的差别就是要鉴权 —— 所以"没配 workspace id"
与"配了 id 但没有 key"都必须显式报错回给界面，不能静默回一份空目录，否则用户看到的是"没有技能"
而不是"你少配了一项"。

两个注入面，都在发出外部请求之前关掉：
1. `path` 由请求方给 —— `validate_reference_path` 只放行 `references/` 下的 `.md`；
2. `file_url` 由上游（百炼）给 —— 它是 OSS 预签名地址，我们仍核 scheme 与 host 后缀，
   并且取它时**不带** Bearer（签名已经在 URL 里，把 key 发给 OSS 是没有必要的泄露）。
"""

import os
import re
import urllib.parse

import httpx

from app.config import LLM_API_KEY  # 导入它顺带保证 load_dotenv() 已经跑过

# region 目前只有 cn-beijing 一个取值（文档口径），留口是为了将来不用改代码
REGION = os.environ.get("BAILIAN_REGION", "cn-beijing")

# workspace id 会直接拼进主机名，所以它必须是合法的单段域名标签，不接受任何其它形状。
# 用 fullmatch 而不是 `^…$` + match：`$` 会放过结尾那一个换行，而这串字符要拼进主机名。
_WORKSPACE_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{2,62}")

# read 30s / connect 10s：与 app/mcp/client.py:43 同策略。前端那份 abort 是 35s，
# 必须严格大于这里，否则用户看到的是"什么都没有"而不是上游那句超时文案。
TIMEOUT = httpx.Timeout(30.0, connect=10.0)


def make_client(**kw: object) -> httpx.AsyncClient:
    """trust_env=False：本机系统代理在做 MITM TLS，走环境代理会 UNEXPECTED_EOF（已实测）。"""
    return httpx.AsyncClient(timeout=TIMEOUT, trust_env=False, http2=False, **kw)  # type: ignore[arg-type]


def api_key() -> str:
    return LLM_API_KEY.strip()


def workspace_id() -> str:
    """惰性读 env：uvicorn --reload 之外，单测也要能在导入后改这个值。"""
    return os.environ.get("BAILIAN_WORKSPACE_ID", "").strip()


def base_url() -> str:
    """`https://{workspace_id}.{region}.maas.aliyuncs.com/api/v1/agentstudio`。

    不合形状直接抛 —— 拼出一个指向别处的 URL 比配错报错严重得多。
    """
    ws = workspace_id()
    if not ws:
        raise ValueError("未配置 BAILIAN_WORKSPACE_ID（百炼控制台右上角业务空间 ID，形如 llm-xxxx…）")
    if not _WORKSPACE_RE.fullmatch(ws):
        raise ValueError(f"BAILIAN_WORKSPACE_ID 形状不合法：{ws[:40]!r}")
    if not api_key():
        raise ValueError("未配置 LLM_API_KEY，百炼技能接口无法鉴权")
    return f"https://{ws}.{REGION}.maas.aliyuncs.com/api/v1/agentstudio"


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key()}"}


def is_allowed_package_host(url: str) -> bool:
    """只允许 https + 阿里云 OSS 域名的预签名地址。

    这个 URL 来自上游 JSON 而不是请求方，但它决定我们下一个请求发到哪儿 —— 上游给什么都照办
    不是"信任内部代码"，是把自己变成跳转器。
    """
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.netloc:
        return False
    host = parts.netloc.split("@")[-1].split(":")[0].lower()
    return host == "aliyuncs.com" or host.endswith(".aliyuncs.com")


def validate_reference_path(path: str) -> bool:
    """纯语法校验，不做任何 I/O —— 畸形 path 要在这里就拒掉，一次请求都不该为它发出去。

    三条规则（与 agentexplorer 那条通道时期相同，理由没变）：
    1. 只允许 `references/` 前缀 —— 不让调用方借道取该技能包里的任意文件（含 scripts/）；
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
