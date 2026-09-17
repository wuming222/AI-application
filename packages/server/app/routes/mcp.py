"""外部工具（MCP）的两个只读端点。

契约：HTTP 状态码不表达工具成败（上游失败时 HTTP 仍 200，成败在 JSON-RPC 的 isError），
所以 /call 恒返回 200 + `{text, is_error}`，前端不需要分两条错误路径。
API key 只出现在服务端到百炼的请求头里，绝不出现在响应中。
"""

import time
from typing import Any, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from app.mcp import client
from app.mcp.servers import MCP_SERVERS, find_server, tool_prefix

router = APIRouter(prefix="/api/mcp", tags=["mcp"])

# 工具清单几乎不变，而每次拉都要走一遍握手；进程内 TTL 缓存，无会话状态
TOOLS_TTL_SECONDS = 600.0
_tools_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


class ToolCallRequest(BaseModel):
    service: str
    tool: str
    arguments: Optional[dict[str, Any]] = None


@router.get("/tools")
async def list_external_tools(refresh: bool = False):
    servers = [
        {"id": cfg.id, "label": cfg.label, "defaultEnabled": cfg.default_enabled}
        for cfg in MCP_SERVERS
    ]
    tools: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []

    for cfg in MCP_SERVERS:
        cached = _tools_cache.get(cfg.id)
        if not refresh and cached and (time.monotonic() - cached[0]) < TOOLS_TTL_SECONDS:
            tools.extend(cached[1])
            continue
        try:
            listed = await client.list_tools(cfg)
        except Exception as err:  # noqa: BLE001 - 单个 server 挂掉不能带走整个端点
            errors.append({"service": cfg.id, "message": str(err)[:300]})
            if cached:
                tools.extend(cached[1])  # 有旧清单就用旧的，别因为上游抖动让能力消失
            continue
        normalized = [
            {
                "name": f"{tool_prefix(cfg.id)}{t['name']}",
                "service": cfg.id,
                "tool": t["name"],
                "description": t["description"],
                "parameters": t["inputSchema"],
            }
            for t in listed
        ]
        _tools_cache[cfg.id] = (time.monotonic(), normalized)
        tools.extend(normalized)

    return {"servers": servers, "tools": tools, "errors": errors}


@router.post("/call")
async def call_external_tool(body: ToolCallRequest):
    cfg = find_server(body.service)
    if not cfg:
        return {"text": f"外部工具未启用：未知的服务 {body.service}", "is_error": True}
    try:
        return await client.call_tool(cfg, body.tool, body.arguments or {})
    except Exception as err:  # noqa: BLE001 - 超时/连接失败都是可恢复事件，回文本让模型改口
        return {"text": f"外部工具调用失败：{err}", "is_error": True}
