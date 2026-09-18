"""内置 MCP server 清单（v1 写死在服务端，不做用户添加界面）。

配置不能放前端：鉴权 key 与百炼服务地址都不应出现在浏览器里，浏览器只拿到工具清单。
"""

import os
from dataclasses import dataclass

from app.config import LLM_API_KEY

# 默认是百炼托管端点；离线验证（假 MCP server）时用它把整条链跑通，零模型 token
MCP_BASE_URL = os.environ.get("MCP_BASE_URL", "https://dashscope.aliyuncs.com/api/v1/mcps")


@dataclass(frozen=True)
class MCPServerConfig:
    id: str
    label: str
    transport: str  # "streamable_http" | "sse"
    default_enabled: bool


# 实测（docs/origin/26-9-17.md）两个服务的传输形态相反：amap 只开 Streamable HTTP，
# AntV 对 /mcp 返回 405、只开 SSE。AntV 一个 server 就 53,768 字符 schema，所以默认关。
MCP_SERVERS: list[MCPServerConfig] = [
    MCPServerConfig("amap-maps", "高德地图", "streamable_http", True),
    MCPServerConfig("antv-visualization-chart", "AntV 图表", "sse", False),
]


def find_server(server_id: str) -> MCPServerConfig | None:
    for cfg in MCP_SERVERS:
        if cfg.id == server_id:
            return cfg
    return None


def tool_prefix(server_id: str) -> str:
    return f"mcp__{server_id}__"


def endpoint_url(cfg: MCPServerConfig) -> str:
    suffix = "mcp" if cfg.transport == "streamable_http" else "sse"
    return f"{MCP_BASE_URL}/{cfg.id}/{suffix}"


def auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {LLM_API_KEY}"}
