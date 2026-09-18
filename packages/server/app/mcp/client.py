"""最小 MCP 客户端：只用到 initialize / notifications/initialized / tools/list / tools/call。

不用官方 mcp SDK：装到的 2.2.0 把入口改名成 `streamable_http_client` 且返回 `TransportStreams`，
依赖的是另一套 HTTP 栈 `httpx2`（与本项目服务端的 httpx 0.28 并存）。我们需要的只有三个 JSON-RPC
方法，手搓约 200 行即可覆盖，且能显式 `trust_env=False` —— 本机系统代理在 MITM TLS，默认走环境
代理会 `UNEXPECTED_EOF_WHILE_READING`（已实测，见 docs/origin/26-9-17.md）。

**每次调用开一条会话、用完即关**，不做跨请求的连接池：连接状态一旦全局共享，就与本项目"会话相关
状态必须分片"的纪律相反，还要额外管握手复用与崩溃重启；代价只是每次调用多一遍 initialize。

超时不用 asyncio.timeout（pyproject 声明支持 3.10，且被取消的任务里 finally 还得再 await 一次收
尾连接），改成三层确定性上界：httpx 的 connect/read 超时兜"连不上、一个字节都不发"，读流时每行
检查一次截止时间兜"持续发心跳却从不回你要的那条帧"（这种上游会不断重置 httpx 的 read 超时），
帧计数上界兜"疯狂发帧"。三条路都转成 McpError，调用方拿到的是可恢复文本而不是异常。
"""

import json
import time
import urllib.parse
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx

from app.mcp.servers import MCPServerConfig, auth_headers, endpoint_url

PROTOCOL_VERSION = "2025-03-26"
CLIENT_INFO = {"name": "huiyingyong-mcp-client", "version": "0.1.0"}

# 与 read_file 的 8,000 同档：外部结果直接进模型上下文，从源头限住体积
MAX_RESULT_CHARS = 8000

# 一个 RPC 回复最多翻多少个 SSE 帧。正常个位数，撞到上界说明上游在刷屏不给对应 id 的回复。
MAX_EVENTS_PER_REQUEST = 2000


class McpError(Exception):
    """会话建立或单次 RPC 失败。调用方一律转成 isError 的文本，不往上抛。"""


def _make_client(timeout: float) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=httpx.Timeout(timeout, connect=10.0),
        trust_env=False,
        http2=False,
    )


async def _sse_events(
    resp: httpx.Response, deadline: float | None = None, timeout: float = 0.0
) -> AsyncIterator[tuple[str, str]]:
    """把 SSE 响应切成 (event, data) 流。多行 data 按 MCP 要求以换行拼接。

    逐行检查截止时间：只发 `:` 心跳帧的上游会让下面两个循环永远等不到匹配 id 的帧，
    而它的每个字节都在重置 httpx 的 read 超时。
    """
    name, data = "message", []
    async for line in resp.aiter_lines():
        if deadline is not None and time.monotonic() > deadline:
            raise McpError(f"调用超时（{timeout:.0f}s 内未返回结果）")
        if line == "":
            if data:
                yield name, "\n".join(data)
            name, data = "message", []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            name = line[6:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())


def _pick_rpc(body_text: str, want_id: int) -> dict | None:
    """响应可能是 JSON，也可能是 Streamable HTTP 的 SSE 帧。取 id 匹配的那条。

    id 两侧都按字符串比：JSON-RPC 允许上游用字符串 id 回我们发的数字 id，严格 `==` 会把它判成
    "无回复"，而那句报错含糊得多（看不出是协议对不上还是上游真的没回）。
    """
    try:
        payload = json.loads(body_text)
    except json.JSONDecodeError:
        return None
    if isinstance(payload, dict) and str(payload.get("id")) == str(want_id):
        return payload
    return None


def _rpc_result(body: dict, method: str) -> dict:
    if "error" in body:
        raise McpError(f"{method} 返回错误: {json.dumps(body['error'], ensure_ascii=False)[:300]}")
    return body.get("result") or {}


class _StreamableHttpTransport:
    """POST 到 /mcp 同步拿回复。实测 amap 不回 mcp-session-id，所以 session 头是可选的。"""

    def __init__(self, client: httpx.AsyncClient, cfg: MCPServerConfig, timeout: float):
        self._client = client
        self._timeout = timeout
        self._deadline = time.monotonic() + timeout
        self._url = endpoint_url(cfg)
        self._headers = {
            **auth_headers(),
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        self._session_id: str | None = None
        self._next_id = 0

    def _post_headers(self) -> dict[str, str]:
        headers = dict(self._headers)
        headers["MCP-Protocol-Version"] = PROTOCOL_VERSION
        if self._session_id:
            headers["mcp-session-id"] = self._session_id
        return headers

    async def open(self) -> None:
        return None

    async def _post(self, payload: dict) -> httpx.Response:
        """流式发送：Streamable HTTP 的回复可能是 SSE 长流，非流式 post() 会等整包读完 ——
        对只发心跳不上回复的上游就是永久挂住（假 server 实测到过）。调用方负责 aclose。"""
        left = max(0.1, self._deadline - time.monotonic())
        try:
            request = self._client.build_request(
                "POST",
                self._url,
                json=payload,
                headers=self._post_headers(),
                timeout=httpx.Timeout(left, connect=10.0),
            )
            return await self._client.send(request, stream=True)
        except httpx.HTTPError as err:
            raise McpError(f"连接外部工具失败 - {type(err).__name__}: {err}") from err

    async def request(self, method: str, params: dict | None = None) -> dict:
        self._next_id += 1
        want_id = self._next_id
        resp = await self._post({"jsonrpc": "2.0", "id": want_id, "method": method, "params": params or {}})
        try:
            if resp.status_code != 200:
                body_text = (await resp.aread()).decode("utf-8", "replace")
                raise McpError(f"HTTP {resp.status_code}: {body_text[:200]}")
            self._session_id = resp.headers.get("mcp-session-id") or self._session_id

            if "text/event-stream" in (resp.headers.get("content-type") or ""):
                body = None
                frames = 0
                async for _, data in _sse_events(resp, self._deadline, self._timeout):
                    frames += 1
                    if frames > MAX_EVENTS_PER_REQUEST:
                        raise McpError(f"外部工具在 {MAX_EVENTS_PER_REQUEST} 帧内未回复 {method}")
                    body = _pick_rpc(data, want_id)
                    if body:
                        break
            else:
                body = _pick_rpc((await resp.aread()).decode("utf-8", "replace"), want_id)

            if not body:
                raise McpError(f"外部工具对 {method} 无回复")
            return _rpc_result(body, method)
        finally:
            await resp.aclose()

    async def notify(self, method: str) -> None:
        resp = await self._post({"jsonrpc": "2.0", "method": method})
        await resp.aclose()

    async def close(self) -> None:
        return None


class _SseTransport:
    """GET /sse 常驻读流 + POST 到 endpoint 事件给的地址；回复只从 SSE 流回来，按 JSON-RPC id 对齐。"""

    def __init__(self, client: httpx.AsyncClient, cfg: MCPServerConfig, timeout: float):
        self._client = client
        self._timeout = timeout
        self._deadline = time.monotonic() + timeout
        self._url = endpoint_url(cfg)
        self._headers = auth_headers()
        self._post_url = ""
        self._next_id = 0
        self._stream_ctx = None
        self._events = None

    async def _next_event(self) -> tuple[str, str] | None:
        """取下一帧；None 表示流已结束。读流出错转成 McpError，别把 httpx 异常丢给调用方。"""
        try:
            return await self._events.__anext__()
        except StopAsyncIteration:
            return None
        except httpx.ReadTimeout as err:
            raise McpError(f"调用超时（{self._timeout:.0f}s 内未返回结果）") from err
        except httpx.HTTPError as err:
            raise McpError(f"读取外部工具回复失败 - {type(err).__name__}: {err}") from err

    async def open(self) -> None:
        self._stream_ctx = self._client.stream(
            "GET", self._url, headers={**self._headers, "Accept": "text/event-stream"}
        )
        try:
            resp = await self._stream_ctx.__aenter__()
        except httpx.HTTPError as err:
            self._stream_ctx = None
            raise McpError(f"连接外部工具失败 - {type(err).__name__}: {err}") from err
        if resp.status_code != 200:
            await self.close()
            raise McpError(f"SSE 建流失败: HTTP {resp.status_code}")
        self._events = _sse_events(resp, self._deadline, self._timeout).__aiter__()
        for _ in range(MAX_EVENTS_PER_REQUEST):
            frame = await self._next_event()
            if frame is None:
                break
            name, data = frame
            if name == "endpoint":
                # data 形如 /api/v1/mcps/{service}/message?sessionId=...，要按 sse 地址解析
                self._post_url = urllib.parse.urljoin(self._url, data.strip())
                return
        await self.close()
        raise McpError("外部工具未下发 endpoint 事件")

    async def _post(self, payload: dict) -> None:
        try:
            resp = await self._client.post(
                self._post_url,
                json=payload,
                headers={
                    **self._headers,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
        except httpx.HTTPError as err:
            raise McpError(f"连接外部工具失败 - {type(err).__name__}: {err}") from err
        # 建流之后 POST 只该拿 202；非 202 说明这条会话已经被上游丢了
        if resp.status_code not in (200, 202, 204):
            raise McpError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    async def request(self, method: str, params: dict | None = None) -> dict:
        if not self._events:
            raise McpError("外部工具会话未建立")
        self._next_id += 1
        want_id = self._next_id
        await self._post({"jsonrpc": "2.0", "id": want_id, "method": method, "params": params or {}})

        for _ in range(MAX_EVENTS_PER_REQUEST):
            frame = await self._next_event()
            if frame is None:
                break
            body = _pick_rpc(frame[1], want_id)
            if body:
                return _rpc_result(body, method)
        raise McpError(f"外部工具在 {MAX_EVENTS_PER_REQUEST} 帧内未回复 {method}")

    async def notify(self, method: str) -> None:
        await self._post({"jsonrpc": "2.0", "method": method})

    async def close(self) -> None:
        events, self._events = self._events, None
        if events:
            await events.aclose()
        ctx, self._stream_ctx = self._stream_ctx, None
        if ctx:
            await ctx.__aexit__(None, None, None)


@asynccontextmanager
async def _connect(cfg: MCPServerConfig, timeout: float):
    client = _make_client(timeout)
    transport = (_StreamableHttpTransport if cfg.transport == "streamable_http" else _SseTransport)(
        client, cfg, timeout
    )
    try:
        await transport.open()
        await transport.request(
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
        )
        await transport.notify("notifications/initialized")
        yield transport
    finally:
        await transport.close()
        await client.aclose()


async def list_tools(cfg: MCPServerConfig, timeout: float = 20.0) -> list[dict]:
    async with _connect(cfg, timeout) as session:
        result = await session.request("tools/list")
    return [
        {
            "name": tool["name"],
            "description": tool.get("description") or "",
            "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
        }
        for tool in (result.get("tools") or [])
        if tool.get("name")
    ]


async def call_tool(cfg: MCPServerConfig, tool: str, arguments: dict, timeout: float = 30.0) -> dict:
    """返回 {text, is_error}，**不抛异常**。

    **成功与否看 JSON-RPC 的 isError**，上游 HTTP 恒 200；超时/连不上这类会话层失败也走同一条
    is_error 路径，模型收到的是一句中文而不是异常。
    """
    try:
        async with _connect(cfg, timeout) as session:
            result = await session.request("tools/call", {"name": tool, "arguments": arguments})
    except McpError as err:
        return {"text": f"外部工具调用失败：{err}", "is_error": True}
    text, is_error = _flatten(result)
    return {"text": text, "is_error": is_error}


def _flatten(result: dict) -> tuple[str, bool]:
    """把 content 拍成一段文本。**不因上游形状异常而抛** —— 调用方（call_tool / 路由）承诺过
    只回可恢复文本，这里再收窄一次，否则 `content: "字符串"` 这类畸形回复会变成 500。
    """
    parts: list[str] = []
    content = result.get("content")
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text":
            parts.append(block.get("text") or "")
        else:
            # 不能静默丢掉：模型需要知道有内容没拿到，否则会凭空补一段
            parts.append(f"[非文本内容: {block.get('type')}]")
    if not parts and result.get("structuredContent") is not None:
        parts.append(json.dumps(result["structuredContent"], ensure_ascii=False))
    text = "\n".join(parts).strip() or "(空结果)"
    if len(text) > MAX_RESULT_CHARS:
        text = text[:MAX_RESULT_CHARS] + f"\n（结果已截断，原内容 {len(text)} 字符）"
    return text, bool(result.get("isError"))
